/**
 * Identity resolution — the LID/phone-number duality.
 *
 * WhatsApp addresses people two ways. The historical form is the phone
 * number (`447700900102@s.whatsapp.net`, "PN"); the newer privacy form
 * is a linked identity (`190000000000001@lid`, "LID") that hides the
 * number. Which one arrives depends on the sender's privacy settings and
 * the chat's addressing mode, and neither is derivable from the other —
 * they are looked up.
 *
 * This matters because every allowlist a human writes is phone numbers.
 * Matching those against a raw `remoteJid` silently ignores anyone whose
 * messages arrive as a LID — which is exactly what happened on the first
 * real message to the live account.
 *
 * So every identity resolves to BOTH forms and matches on either.
 * Baileys carries the counterpart on the message key (`remoteJidAlt` /
 * `participantAlt`) when it knows it, and its signal store can look one
 * up otherwise; results are cached because the mapping is stable.
 */

import { isLidUser, jidNormalizedUser, type WASocket } from "baileys";

export type Identity = {
  /** Phone-number form, digits only, when known: "447700900102". */
  phone?: string;
  /** LID form, digits only, when known: "190000000000001". */
  lid?: string;
  /** Every bare id this person is known by — what allowlists match on. */
  ids: string[];
};

/**
 * Bare identity of a JID or phone string: strips server, device, and
 * "+". Returns undefined for anything that leaves no digits — WhatsApp
 * hands out empty `participant` fields on DMs, and an empty id that
 * flows onward silently collapses every conversation into one.
 */
export function bareId(jidOrNumber: string | null | undefined): string {
  return jidOrNumber?.split("@")[0].split(":")[0].replace(/^\+/, "") ?? "";
}

/** Bare id, or undefined when there is nothing usable to key on. */
function usableId(jidOrNumber: string | null | undefined): string | undefined {
  const bare = bareId(jidOrNumber).trim();
  return bare.length > 0 ? bare : undefined;
}

/** LID ↔ PN is stable for the life of an account; cache both directions. */
const cache = new Map<string, Identity>();

function remember(identity: Identity): Identity {
  // Nothing to key on means nothing worth caching — the next message
  // gets a fresh attempt at resolving this person.
  for (const id of identity.ids) cache.set(id, identity);
  return identity;
}

type LidStore = {
  getPNForLID(lid: string): Promise<string | null>;
  getLIDForPN(pn: string): Promise<string | null>;
};

function lidStore(
  sock: Pick<WASocket, "signalRepository"> | null,
): LidStore | undefined {
  return (
    sock?.signalRepository as unknown as { lidMapping?: LidStore } | undefined
  )?.lidMapping;
}

/**
 * Resolve a user JID into every form they can be addressed by.
 *
 * `altJid` is Baileys' counterpart hint from the message key — free when
 * present. Otherwise the signal store is asked, a local lookup that can
 * still miss (the mapping is learned, not computed). A one-sided answer
 * is returned rather than failing, so matching degrades to the form we
 * do have instead of dropping the message.
 */
export async function resolveIdentity(
  sock: Pick<WASocket, "signalRepository"> | null,
  jid: string,
  altJid?: string | null,
): Promise<Identity> {
  const bare = usableId(jid);
  const cached = bare ? cache.get(bare) : undefined;
  if (cached) return cached;

  const isLid = Boolean(isLidUser(jid));
  const identity: Identity = isLid
    ? { lid: bare, ids: [] }
    : { phone: bare, ids: [] };

  const altBare = usableId(altJid);
  if (altBare) {
    if (isLid) identity.phone = altBare;
    else identity.lid = altBare;
  } else {
    const store = lidStore(sock);
    if (store) {
      try {
        const counterpart = isLid
          ? await store.getPNForLID(jidNormalizedUser(jid))
          : await store.getLIDForPN(jidNormalizedUser(jid));
        const counterpartId = usableId(counterpart);
        if (counterpartId) {
          if (isLid) identity.phone = counterpartId;
          else identity.lid = counterpartId;
        }
      } catch {
        // A miss is normal before the mapping is learned — match on the
        // form we have rather than failing the message.
      }
    }
  }

  identity.ids = [identity.phone, identity.lid].filter((id): id is string =>
    Boolean(id),
  );
  return remember(identity);
}

/**
 * True when an identity is on an allowlist of bare ids. Either form
 * counts: the allowlist is written in phone numbers, the message may
 * arrive as a LID, and both name the same person.
 */
export function identityAllowed(
  identity: Identity,
  allowed: ReadonlySet<string>,
): boolean {
  return identity.ids.some((id) => allowed.has(id));
}

/**
 * The stable, human-meaningful id for a person: their phone number when
 * known, else the LID. Chat ids are built from this so a conversation
 * keeps one identity even as WhatsApp switches addressing form.
 */
export function canonicalId(identity: Identity): string | undefined {
  // Deliberately not `??`: an empty string is "no id", not a value, and
  // letting one through builds a chat id every DM would share.
  return identity.phone || identity.lid || undefined;
}

/** Test seam: forget every resolved identity. */
export function resetIdentityCache(): void {
  cache.clear();
}
