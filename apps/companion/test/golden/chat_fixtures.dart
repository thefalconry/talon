/// Chat scenarios for the golden renders. Each one is a single seeded chat
/// (plus, where it matters, a live turn) that reproduces a situation the
/// conversation view has to handle well.
library;

import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/state/app_state.dart';

import 'golden_harness.dart';

class ChatScenario {
  final String name;
  final String title;
  final List<ClientMessage> messages;

  /// Optional live-turn state applied after seeding.
  final void Function(TurnState turn)? live;

  const ChatScenario(this.name, this.title, this.messages, {this.live});
}

ClientMessage _m(
  String id,
  Role role,
  String text, {
  int minutes = 0,
  int seconds = 0,
  List<ToolActivity>? tools,
  String? imagePath,
  List<Attachment>? attachments,
  List<String>? reactions,
  int? durationMs,
  int? tokensIn,
  int? tokensOut,
}) =>
    ClientMessage(
      id: id,
      chatId: 'c1',
      role: role,
      text: text,
      ts: tsAt(minutes: minutes, seconds: seconds),
      tools: tools,
      imagePath: imagePath,
      attachments: attachments,
      reactions: reactions,
      durationMs: durationMs,
      tokensIn: tokensIn,
      tokensOut: tokensOut,
    );

ToolActivity _tool(
  String id,
  String name,
  Map<String, dynamic> input, {
  bool done = true,
  int ms = 1800,
  String? error,
}) {
  final start = DateTime.now().subtract(Duration(milliseconds: ms + 500));
  return ToolActivity(
    id: id,
    name: name,
    input: input,
    done: done,
    error: error,
    startedAt: start,
    finishedAt: done ? start.add(Duration(milliseconds: ms)) : null,
  );
}

/// The case the operator called out: the agent sends several short messages
/// mid-turn (send_message) while it keeps working, with a tool still running.
final burst = ChatScenario(
  'burst',
  'Staging health check',
  [
    _m('1', Role.user,
        'Can you check the three staging servers and tell me what is wrong?',
        minutes: 4, seconds: 30),
    _m('2', Role.assistant, "On it — checking staging-1 first.",
        minutes: 4,
        seconds: 10,
        tools: [
          _tool('t1', 'mcp__ssh-tools__execute-command',
              {'server': 'staging-1', 'command': 'uptime && df -h /'}),
        ]),
    _m('3', Role.assistant, 'staging-1 is healthy: load 0.4, disk 41%.',
        minutes: 3, seconds: 40),
    _m('4', Role.assistant,
        'staging-2 has a full `/var` (98%). Looking at what is filling it.',
        minutes: 3,
        seconds: 5,
        tools: [
          _tool('t2', 'mcp__ssh-tools__execute-command',
              {'server': 'staging-2', 'command': 'df -h /var'}),
          _tool('t3', 'mcp__ssh-tools__execute-command',
              {'server': 'staging-2', 'command': 'du -sh /var/* | sort -rh'},
              ms: 4200),
        ]),
    _m('5', Role.assistant,
        "It's journald — 11 GB of logs since the last rotate.",
        minutes: 2, seconds: 20),
    _m('6', Role.assistant, 'Checking staging-3 now.',
        minutes: 1, seconds: 50),
  ],
  live: (t) {
    t.active = true;
    t.typing = false;
    t.tools.add(_tool('t4', 'mcp__ssh-tools__execute-command',
        {'server': 'staging-3', 'command': 'systemctl --failed'},
        done: false, ms: 2600));
  },
);

/// A reply mid-stream: reasoning folded, one finished tool, partial markdown.
final streaming = ChatScenario(
  'streaming',
  'Weekend plan',
  [
    _m('1', Role.user, 'Plan a weekend in Kerry — hiking plus one nice dinner.',
        minutes: 1),
  ],
  live: (t) {
    t.active = true;
    t.typing = false;
    t.reasoning.add('The user wants a two-day itinerary. Check the forecast '
        'first, then pick a ridge walk that suits a dry morning.');
    t.tools.add(_tool('t1', 'web_search',
        {'query': 'Killarney weather this weekend'}));
    t.draft = "Here's a tight plan for the weekend:\n\n"
        '1. **Saturday morning** — Torc Mountain from the Muckross side '
        '(2.5 h, ridge views).\n'
        '2. **Saturday evening** — dinner in Killarney town; the 7:30 '
        'slot is usually';
  },
);

/// A markdown-heavy reply: headings, lists, a table, inline code, a link,
/// a quote.
final markdown = ChatScenario(
  'markdown',
  'Bridge ports',
  [
    _m('1', Role.user, 'Which ports does the bridge use, and how do I change them?',
        minutes: 3),
    _m(
      '2',
      Role.assistant,
      '## Bridge ports\n\n'
          'The daemon listens on two ports by default:\n\n'
          '| Port | Purpose | Config key |\n'
          '|------|---------|------------|\n'
          '| 19880 | HTTPS bridge (chat, SSE, media) | `native.port` |\n'
          '| 19881 | Local discovery beacon | `native.discoveryPort` |\n\n'
          '### Changing them\n\n'
          '1. Edit `~/.talon/config.json`.\n'
          '2. Set `native.port` to a free port.\n'
          '3. Restart the daemon with `talon restart`.\n\n'
          '- Companions pinned to the old port need to **re-pair**.\n'
          '- A reverse proxy in front of the bridge only needs its '
          '*upstream* updated.\n\n'
          '> Tip: `talon doctor` prints the ports it actually bound.\n\n'
          'Full reference: [bridge configuration](https://example.com/docs/bridge).',
      minutes: 2,
      durationMs: 8400,
      tokensIn: 3100,
      tokensOut: 420,
    ),
  ],
);

final _longCode = [
  'import { readFile } from "node:fs/promises";',
  'import { createHash } from "node:crypto";',
  '',
  'export interface ManifestEntry {',
  '  path: string;',
  '  sha256: string;',
  '  size: number;',
  '}',
  '',
  '/** Hash every file in the manifest and report the ones that drifted from the recorded digest. */',
  'export async function verifyManifest(entries: ManifestEntry[]): Promise<string[]> {',
  '  const drifted: string[] = [];',
  '  for (const entry of entries) {',
  '    const bytes = await readFile(entry.path);',
  '    const digest = createHash("sha256").update(bytes).digest("hex");',
  '    if (digest !== entry.sha256 || bytes.byteLength !== entry.size) {',
  '      drifted.push(`\${entry.path}: expected \${entry.sha256.slice(0, 12)}…, got \${digest.slice(0, 12)}…`);',
  '    }',
  '  }',
  '  return drifted;',
  '}',
  '',
  'export async function main(argv: string[]): Promise<number> {',
  '  const manifest = JSON.parse(await readFile(argv[0] ?? "manifest.json", "utf8"));',
  '  const drifted = await verifyManifest(manifest.entries);',
  '  for (const line of drifted) console.error(line);',
  '  return drifted.length === 0 ? 0 : 1;',
  '}',
].join('\n');

final longCode = ChatScenario(
  'long_code',
  'Manifest verifier',
  [
    _m('1', Role.user, 'Write me a manifest verifier in TypeScript.',
        minutes: 2),
    _m(
      '2',
      Role.assistant,
      'Here you go — it streams each file once and reports drift:\n\n'
          '```ts\n$_longCode\n```\n\n'
          'Run it with `npx tsx verify.ts manifest.json`.',
      minutes: 1,
      durationMs: 14200,
      tokensIn: 2600,
      tokensOut: 780,
    ),
  ],
);

/// An error note between turns, plus a failed tool call.
final error = ChatScenario(
  'error',
  'Deploy',
  [
    _m('1', Role.user, 'Deploy the docs site.', minutes: 6),
    _m('2', Role.assistant, "Building the site first.",
        minutes: 5,
        tools: [
          _tool('t1', 'bash', {'command': 'npm run build'},
              error: 'exit code 1: Cannot find module "vitepress"'),
        ]),
    _m('3', Role.system,
        'Turn failed: the model provider is overloaded (HTTP 529). '
            'Your message was kept — send again to retry.',
        minutes: 5, seconds: -20),
    _m('4', Role.user, 'Try again please.', minutes: 1),
  ],
);

/// A photo from the user, a file + image back from the agent.
final media = ChatScenario(
  'media',
  'Receipts',
  [
    _m('1', Role.user, 'Here is the receipt from Friday.',
        minutes: 4,
        imagePath: '/media?id=img1',
        attachments: const [
          Attachment(
              path: '/tmp/receipt.png',
              name: 'receipt.png',
              size: 482133,
              mimeType: 'image/png',
              url: '/media?id=img1',
              image: true),
        ]),
    _m('2', Role.assistant,
        'Logged it: **€64.20** at Mews, Killarney. Here is the updated '
            'expense report.',
        minutes: 3,
        attachments: const [
          Attachment(
              path: '/tmp/expenses-september.pdf',
              name: 'expenses-september.pdf',
              size: 218400,
              mimeType: 'application/pdf',
              url: '/media?id=f1',
              image: false),
          Attachment(
              path: '/tmp/expenses.csv',
              name: 'expenses.csv',
              size: 3120,
              mimeType: 'text/csv',
              url: '/media?id=f2',
              image: false),
        ],
        durationMs: 5100,
        tokensIn: 1800,
        tokensOut: 90),
  ],
);

/// An ordinary back-and-forth spread over the day, with a yesterday divider.
final alternation = ChatScenario(
  'alternation',
  'Dinner ideas',
  [
    _m('1', Role.user, 'Something warm for tonight, not too heavy?',
        minutes: 60 * 24 + 30),
    _m('2', Role.assistant,
        'A miso-glazed salmon with greens — 25 minutes, one tray.',
        minutes: 60 * 24 + 29),
    _m('3', Role.user, 'Made the salmon, it was great.', minutes: 95),
    _m('4', Role.assistant, 'Glad it landed! Want a variation for next week?',
        minutes: 94, reactions: ['❤️']),
    _m('5', Role.user, 'Yes — vegetarian this time.', minutes: 12),
    _m('6', Role.user, 'And something I can batch cook.', minutes: 11),
    _m('7', Role.assistant,
        'A chickpea and squash tagine: it keeps for four days and freezes '
            'well. I can send a shopping list if you like.',
        minutes: 10, durationMs: 4300, tokensIn: 900, tokensOut: 120),
  ],
);

final empty = ChatScenario('empty', 'New chat', const []);

final allChatScenarios = [
  burst,
  streaming,
  markdown,
  longCode,
  error,
  media,
  alternation,
  empty,
];

ClientChat chatFor(ChatScenario s) => ClientChat(
      id: 'c1',
      title: s.title,
      createdAt: tsAt(minutes: 600),
      lastActive: s.messages.isEmpty ? tsAt() : s.messages.last.ts,
      preview: s.messages.isEmpty ? '' : s.messages.last.text,
      model: 'opus',
      effort: 'adaptive',
    );

/// Background chats so the desktop sidebar isn't empty.
List<ClientChat> sidebarChats() => [
      ClientChat(
          id: 'c2',
          title: 'VPS disk cleanup',
          createdAt: tsAt(minutes: 900),
          lastActive: tsAt(minutes: 40),
          preview: 'Freed 3.1G by pruning old builds.'),
      ClientChat(
          id: 'c3',
          title: 'Flutter back gesture',
          createdAt: tsAt(minutes: 1900),
          lastActive: tsAt(minutes: 300),
          preview: 'PopScope handles predictive back.'),
    ];
