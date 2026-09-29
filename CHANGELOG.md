# Changelog

## [5.21.0](https://github.com/thefalconry/talon/compare/v5.20.1...v5.21.0) (2026-09-29)


### Features

* **companion:** collapse tool calls into a Claude-style group dropdown ([#1133](https://github.com/thefalconry/talon/issues/1133)) ([44d54e2](https://github.com/thefalconry/talon/commit/44d54e229d6c28b5f1babf9015826b2d2db5f043))
* **companion:** confirm a hand-typed bridge's certificate before sending the token ([#1123](https://github.com/thefalconry/talon/issues/1123)) ([9314277](https://github.com/thefalconry/talon/commit/9314277716362293245d798f7318828f2f13f316))
* **companion:** ship a Windows .exe installer ([#1132](https://github.com/thefalconry/talon/issues/1132)) ([4915e5f](https://github.com/thefalconry/talon/commit/4915e5f280511b692fa4ef54972847812e4d94c9))
* **mesh:** audit every device command and read it with talon mesh audit ([#1128](https://github.com/thefalconry/talon/issues/1128)) ([7a6afde](https://github.com/thefalconry/talon/commit/7a6afde5e571faea48a14c2e4180043d5caf61e3))
* **mesh:** on-device command audit on talon-node and the companion ([#1122](https://github.com/thefalconry/talon/issues/1122)) ([40ec0cd](https://github.com/thefalconry/talon/commit/40ec0cda6d2bdb21c5271f6a4caa89ff449eb590))
* **mesh:** sha256 payload digests on streamed device transfers ([#1127](https://github.com/thefalconry/talon/issues/1127)) ([f48cbed](https://github.com/thefalconry/talon/commit/f48cbedb3bd8add40763bf0b58f0ca635ce9fe09))
* **node:** opt-in strict TLS and a loud TOFU banner ([#1131](https://github.com/thefalconry/talon/issues/1131)) ([58a2887](https://github.com/thefalconry/talon/commit/58a28874e13cf3493c5e305efceb9582ca64513c))


### Bug Fixes

* **companion:** follow Linux desktop theme mode and dynamic accent colors ([#1135](https://github.com/thefalconry/talon/issues/1135)) ([8d351f2](https://github.com/thefalconry/talon/commit/8d351f21050afd3a2b8f582465528be64205c0e6))
* **companion:** keep the bridge token out of URLs ([#1119](https://github.com/thefalconry/talon/issues/1119)) ([ea246a1](https://github.com/thefalconry/talon/commit/ea246a13328bd5d7cc9f1c5b0a863789885e00a8))
* **companion:** show the build commit next to the app version ([#1137](https://github.com/thefalconry/talon/issues/1137)) ([e170ce1](https://github.com/thefalconry/talon/commit/e170ce1dee58203de2a17972a8693c2a123231ee))
* **companion:** unblock typing '?' and move keyboard help to Settings ([#1136](https://github.com/thefalconry/talon/issues/1136)) ([c794cb0](https://github.com/thefalconry/talon/commit/c794cb09789ba91d55cd86fb5655b221177ac2bd))
* **mesh:** pin the bridge key in node installers and refuse shell-unsafe URLs ([#1121](https://github.com/thefalconry/talon/issues/1121)) ([8183bcd](https://github.com/thefalconry/talon/commit/8183bcda1fcb76844bd4030bddfb1f4b613fbba3))
* **security:** restore maximum-permission defaults, restrictions opt-in ([#1126](https://github.com/thefalconry/talon/issues/1126)) ([d610639](https://github.com/thefalconry/talon/commit/d61063956fc99deb867f51cd6a43e9659a76b073))
* **update:** verify companion and node updates without a release key ([#1129](https://github.com/thefalconry/talon/issues/1129)) ([009d580](https://github.com/thefalconry/talon/commit/009d580e317fe1e341b41c13394458fbcc9f0d18))


### Miscellaneous Chores

* **deps:** Bump ip-address from 10.4.0 to 10.7.2 ([#1142](https://github.com/thefalconry/talon/issues/1142)) ([a60ecca](https://github.com/thefalconry/talon/commit/a60eccaf0df4e85ad5b73c858b2e3f749f18727b))
* **deps:** Bump the production-dependencies group with 4 updates ([#1140](https://github.com/thefalconry/talon/issues/1140)) ([7290300](https://github.com/thefalconry/talon/commit/7290300d8c3657aa35543451d59fc73f97534dcb))
* **deps:** Bump undici ([#1141](https://github.com/thefalconry/talon/issues/1141)) ([c942f7c](https://github.com/thefalconry/talon/commit/c942f7c77dc9d863cec4d6e4c722041b03cd95b0))

## [5.20.1](https://github.com/thefalconry/talon/compare/v5.20.0...v5.20.1) (2026-09-28)


### Bug Fixes

* **gateway:** let sub-agents reach chat-free actions (mesh, send_via, backup) ([#1109](https://github.com/thefalconry/talon/issues/1109)) ([2616d75](https://github.com/thefalconry/talon/commit/2616d75230258a272172b5c38bd092d574423c91))


### Tests

* **companion:** fix the flaky voice watchdog tests ([#1108](https://github.com/thefalconry/talon/issues/1108)) ([9bc888a](https://github.com/thefalconry/talon/commit/9bc888acb0a9cf47ff0c0d519af88d62f2a9f792))

## [5.20.0](https://github.com/thefalconry/talon/compare/v5.19.1...v5.20.0) (2026-09-28)


### Features

* **docker:** ship zip and unzip in the runtime image ([#1116](https://github.com/thefalconry/talon/issues/1116)) ([f149445](https://github.com/thefalconry/talon/commit/f149445ef6bdcf123cccc1d17065b0c54b516b71))

## [5.19.1](https://github.com/thefalconry/talon/compare/v5.19.0...v5.19.1) (2026-09-27)


### Bug Fixes

* **agents:** honour a kill requested while a sub-agent is still queued ([#1107](https://github.com/thefalconry/talon/issues/1107)) ([a9be2ca](https://github.com/thefalconry/talon/commit/a9be2cad6605e37b5e8cf7e45bba952a63b2c3d4))
* **backup:** include mesh-credentials.json in snapshots ([#1111](https://github.com/thefalconry/talon/issues/1111)) ([ae5446c](https://github.com/thefalconry/talon/commit/ae5446c1289d8fb3adbcf6a1eac3d297710eb130))
* **companion:** stop offering start-at-login inside Flatpak ([#1110](https://github.com/thefalconry/talon/issues/1110)) ([0553078](https://github.com/thefalconry/talon/commit/0553078487cc1af054a93a4a85518d434203c068))
* **mesh,companion:** correct companion version string and stop same-name device eviction ([#1112](https://github.com/thefalconry/talon/issues/1112)) ([d24dd14](https://github.com/thefalconry/talon/commit/d24dd14ef66920ca9ab4173c31a268983a3b9edb))
* **triggers:** stop the orphan sweep from killing the chat's triggers ([#1114](https://github.com/thefalconry/talon/issues/1114)) ([02eaa2f](https://github.com/thefalconry/talon/commit/02eaa2f0b3e36f0a485557973b77f399a7887ce0))


### Miscellaneous Chores

* **deps:** bump @anthropic-ai/claude-agent-sdk to ^0.3.283 ([#1113](https://github.com/thefalconry/talon/issues/1113)) ([41896d7](https://github.com/thefalconry/talon/commit/41896d7d60f888d247c3dc1900b544e3d00e363f))

## [5.19.0](https://github.com/thefalconry/talon/compare/v5.18.2...v5.19.0) (2026-09-25)


### Features

* **agents:** let sibling sub-agents message each other directly ([#1103](https://github.com/thefalconry/talon/issues/1103)) ([290cf66](https://github.com/thefalconry/talon/commit/290cf6676b5387c572cb6aca7155363f8fa3b43e))


### Bug Fixes

* stability sweep + observability — 40 fixes, operator alerts, turn-tagged logs, personal-data scrub ([#1105](https://github.com/thefalconry/talon/issues/1105)) ([6a56bfd](https://github.com/thefalconry/talon/commit/6a56bfd19746b1eed3e44a62441a543cdbdda045))

## [5.18.2](https://github.com/thefalconry/talon/compare/v5.18.1...v5.18.2) (2026-09-25)


### Bug Fixes

* **telegram:** let the agent read back its own Rich Messages ([#1100](https://github.com/thefalconry/talon/issues/1100)) ([6fd5f55](https://github.com/thefalconry/talon/commit/6fd5f55e8b4bd5a23ad1f84d326e1cbc726e22d8))


### Miscellaneous Chores

* relicense under Apache-2.0 ([#1101](https://github.com/thefalconry/talon/issues/1101)) ([29279cf](https://github.com/thefalconry/talon/commit/29279cf236514a4904f03d7b99dbb70f5b2a3fda))

## [5.18.1](https://github.com/thefalconry/talon/compare/v5.18.0...v5.18.1) (2026-09-24)


### Miscellaneous Chores

* remove the operator's name and handle from the tree ([#1098](https://github.com/thefalconry/talon/issues/1098)) ([0c67f9a](https://github.com/thefalconry/talon/commit/0c67f9a63b479ae2e04ac3e07dcb4d1afa4f58dd))

## [5.18.0](https://github.com/thefalconry/talon/compare/v5.17.0...v5.18.0) (2026-09-24)


### Features

* **backup:** capture full state — backend sessions, traces, plugins; restore --clone ([#1043](https://github.com/thefalconry/talon/issues/1043)) ([cfb5efd](https://github.com/thefalconry/talon/commit/cfb5efd583e9e44f472a0f1f801d63c270502252))


### Miscellaneous Chores

* **deps:** Bump actions/checkout from 6.1.0 to 7.0.1 ([#1084](https://github.com/thefalconry/talon/issues/1084)) ([3cb4d59](https://github.com/thefalconry/talon/commit/3cb4d59483020415cf03988be6ea83c392981ffa))
* **deps:** Bump docker/build-push-action from 6.19.2 to 7.4.0 ([#1083](https://github.com/thefalconry/talon/issues/1083)) ([8574f52](https://github.com/thefalconry/talon/commit/8574f528ce5af8de4ecb457602ff68e4a8cbccd0))
* **deps:** Bump docker/metadata-action from 5.10.0 to 6.2.0 ([#1086](https://github.com/thefalconry/talon/issues/1086)) ([9e7ad03](https://github.com/thefalconry/talon/commit/9e7ad034c17b17a7d7c99d29e5cb37ac80a552c8))
* **deps:** Bump docker/setup-buildx-action from 3.12.0 to 4.4.1 ([#1085](https://github.com/thefalconry/talon/issues/1085)) ([d3b1f42](https://github.com/thefalconry/talon/commit/d3b1f425b44aa8553cc61d5622079ecd298217bd))

## [5.17.0](https://github.com/thefalconry/talon/compare/v5.16.0...v5.17.0) (2026-09-24)


### Features

* **scope:** full tool set in groups the operator is a member of ([#1095](https://github.com/thefalconry/talon/issues/1095)) ([e4823e5](https://github.com/thefalconry/talon/commit/e4823e5c0488b0701141d2e4c731de915b41cfb5))


### Bug Fixes

* **scope:** tell the model when a turn runs with the guest tool set ([#1094](https://github.com/thefalconry/talon/issues/1094)) ([e448fa1](https://github.com/thefalconry/talon/commit/e448fa189cf7e322a499014c3d7ac6a4467fa2a5))
* **telegram:** give getUpdates a deadline so a dead socket can't stall polling ([#1093](https://github.com/thefalconry/talon/issues/1093)) ([f6f4d3a](https://github.com/thefalconry/talon/commit/f6f4d3a48b3997dd66ec308f0e1c80ba9c196a49))

## [5.16.0](https://github.com/thefalconry/talon/compare/v5.15.1...v5.16.0) (2026-09-24)


### Features

* **companion:** optional app lock (passcode + biometrics) ([#1087](https://github.com/thefalconry/talon/issues/1087)) ([9a0ebf7](https://github.com/thefalconry/talon/commit/9a0ebf7950d2c529619e85541994f43e38b2ea98))

## [5.15.1](https://github.com/thefalconry/talon/compare/v5.15.0...v5.15.1) (2026-09-24)


### Bug Fixes

* **usage:** read plan quota from idle backends instead of reporting 'not running' ([#1089](https://github.com/thefalconry/talon/issues/1089)) ([80ef309](https://github.com/thefalconry/talon/commit/80ef30992983bd4b3c54eec1403539e3a5d89faa))

## [5.15.0](https://github.com/thefalconry/talon/compare/v5.14.0...v5.15.0) (2026-09-24)


### Features

* **backup:** encrypt snapshot parts and refuse plaintext remote uploads ([#1040](https://github.com/thefalconry/talon/issues/1040)) ([9e10379](https://github.com/thefalconry/talon/commit/9e10379249b9542d32b6ab327654c6d7c0a9e4a0))
* **bridge:** auth hardening — token strength, backoff, global cooldown, timeouts ([#1042](https://github.com/thefalconry/talon/issues/1042) phase 1) ([#1050](https://github.com/thefalconry/talon/issues/1050)) ([7539828](https://github.com/thefalconry/talon/commit/7539828cc97583001c3678e89259aa7fb403da77))
* **mesh:** device-local command policy and bounded command execution ([#1074](https://github.com/thefalconry/talon/issues/1074)) ([370c7c2](https://github.com/thefalconry/talon/commit/370c7c23ec72ff4773f5d0eb376769cf0846fd66))
* **mesh:** per-device credentials, scopes and revocation ([#1042](https://github.com/thefalconry/talon/issues/1042) phase 2) ([#1068](https://github.com/thefalconry/talon/issues/1068)) ([e36e6ea](https://github.com/thefalconry/talon/commit/e36e6eaddd02cdd1be01c73f7f8336c884965b32))


### Bug Fixes

* **backup:** signed manifests, local-only login sessions, owner-only modes (on top of [#1040](https://github.com/thefalconry/talon/issues/1040)) ([#1065](https://github.com/thefalconry/talon/issues/1065)) ([b20adeb](https://github.com/thefalconry/talon/commit/b20adeb5a340eddfa62db7d37ced40a69252e913))
* **companion:** harden pairing links ([#1064](https://github.com/thefalconry/talon/issues/1064)) ([523b20b](https://github.com/thefalconry/talon/commit/523b20b021474531ac64a178db072e78f08d9419))
* **companion:** keep credentials and chats out of backups; private Linux settings file ([#1066](https://github.com/thefalconry/talon/issues/1066)) ([84e0e6a](https://github.com/thefalconry/talon/commit/84e0e6abc87106e94c081adeb2de216149649caf))
* **companion:** keep the bridge token out of errors, logs and screenshots ([#1073](https://github.com/thefalconry/talon/issues/1073)) ([9166e3d](https://github.com/thefalconry/talon/commit/9166e3df4591a5b4e6a1fbb03ffb1122e7970bcd))
* **companion:** private update staging and no-downgrade APK installs ([#1071](https://github.com/thefalconry/talon/issues/1071)) ([6cd47f2](https://github.com/thefalconry/talon/commit/6cd47f27ed9c7ac666d5bbda476a1c277bbdc394))
* **node:** bound command workers, reset reconnect backoff, idle-timeout the stream ([#1080](https://github.com/thefalconry/talon/issues/1080)) ([4849bc4](https://github.com/thefalconry/talon/commit/4849bc4c47f4a5a324f69b94d73e44a344a25f1f))
* **node:** run the Windows boot task as the installing user, not SYSTEM ([#1069](https://github.com/thefalconry/talon/issues/1069)) ([16f83ab](https://github.com/thefalconry/talon/commit/16f83ab669b594634e7d6a78f356ffcf2524029c))
* **security:** harden default access control and local gateway auth ([#1081](https://github.com/thefalconry/talon/issues/1081)) ([641889b](https://github.com/thefalconry/talon/commit/641889beed38be8643972883a74c1f6c42ec3901))
* **security:** hardening checklist — SSRF guard, clone --, admin DM-only, docker, audit ([#1070](https://github.com/thefalconry/talon/issues/1070)) ([86d53f7](https://github.com/thefalconry/talon/commit/86d53f7b4a9f85de7646c19639a44d4384ab1553))
* **security:** per-sender tool scope in shared chats; fail closed where guest scope can't be enforced ([#1078](https://github.com/thefalconry/talon/issues/1078)) ([09513f9](https://github.com/thefalconry/talon/commit/09513f9cf46f65fc71d5a713c181ca8748fa3f7e))
* **userbot:** bound reconnect steps so a hung connect can't wedge the monitor ([#1076](https://github.com/thefalconry/talon/issues/1076)) ([abac1d3](https://github.com/thefalconry/talon/commit/abac1d396ced30a2f9141425ac1a711e6b8d0c3d))


### Performance Improvements

* **companion:** let Android sleep while the mesh service idles ([#1079](https://github.com/thefalconry/talon/issues/1079)) ([6e9463d](https://github.com/thefalconry/talon/commit/6e9463dd80c7cf320740a066b5696df461572cfc))
* **companion:** stop ambient animations when unfocused or idle, add Reduce effects ([#1072](https://github.com/thefalconry/talon/issues/1072)) ([2f8d486](https://github.com/thefalconry/talon/commit/2f8d486bb2be2045481571bceae903f143560a78))
* **companion:** stop per-token rebuild storm and move the snapshot off prefs ([#1077](https://github.com/thefalconry/talon/issues/1077)) ([6361bb7](https://github.com/thefalconry/talon/commit/6361bb73f525bf218f3db3a5ef5cd2c6999d67f7))
* **companion:** stop the Linux scroll crash causes in the chat list ([#1075](https://github.com/thefalconry/talon/issues/1075)) ([e8d6a6c](https://github.com/thefalconry/talon/commit/e8d6a6c66c03891e3e2772c35b0165cdef051d05))


### Tests

* **mesh:** talk to the gateway with its token in the credentials suite ([#1088](https://github.com/thefalconry/talon/issues/1088)) ([42a97e4](https://github.com/thefalconry/talon/commit/42a97e4addf434f375c7ffe2d32a86c317800eff))


### Continuous Integration

* **dependabot:** cooldown, review for production deps, SHA-pinned actions ([#1067](https://github.com/thefalconry/talon/issues/1067)) ([8a2dcff](https://github.com/thefalconry/talon/commit/8a2dcff11f3edca6cd0205a33c7e7977c0818b63))

## [5.14.0](https://github.com/thefalconry/talon/compare/v5.13.0...v5.14.0) (2026-09-24)


### Features

* **status:** show the Talon version (and git commit) in /status ([#1039](https://github.com/thefalconry/talon/issues/1039)) ([8f76c34](https://github.com/thefalconry/talon/commit/8f76c34b4e7a09c6452034a33fceb13533d40fd0))

## [5.13.0](https://github.com/thefalconry/talon/compare/v5.12.0...v5.13.0) (2026-09-24)


### Features

* **companion:** Flatpak packaging for Flathub (client-only) ([#1022](https://github.com/thefalconry/talon/issues/1022)) ([ba623e1](https://github.com/thefalconry/talon/commit/ba623e16d1bec3d1d6c068a87e2022828ca87b8c))

## [5.12.0](https://github.com/thefalconry/talon/compare/v5.11.0...v5.12.0) (2026-09-24)


### Features

* **usage:** redeem a banked Claude limit reset from /usage ([#1035](https://github.com/thefalconry/talon/issues/1035)) ([2eceeef](https://github.com/thefalconry/talon/commit/2eceeeffbd817ba67c55f429690e1901a2c9a161))


### Bug Fixes

* **tests:** de-flake mesh registry cap and MCP-functional-2 boot under load ([#1036](https://github.com/thefalconry/talon/issues/1036)) ([553a4e4](https://github.com/thefalconry/talon/commit/553a4e441e1acc196cd2f5089b519143e8a8c7be))

## [5.11.0](https://github.com/thefalconry/talon/compare/v5.10.0...v5.11.0) (2026-09-24)


### Features

* **config:** make per-chat trigger cap configurable, name config keys in cap errors ([#1032](https://github.com/thefalconry/talon/issues/1032)) ([37e2b0c](https://github.com/thefalconry/talon/commit/37e2b0c2f52675aac077c7a181b317a17066217a))
* **usage:** show Claude banked limit resets in /usage ([#1028](https://github.com/thefalconry/talon/issues/1028)) ([93af389](https://github.com/thefalconry/talon/commit/93af38960e90a6a8f84288b15ee8173014634d28))


### Bug Fixes

* **config:** fail loudly on an invalid config.json instead of falling back to defaults ([#1031](https://github.com/thefalconry/talon/issues/1031)) ([545d4bc](https://github.com/thefalconry/talon/commit/545d4bc6a95c6389f4d98e23ccc9643b9a723114))
* **daemon:** keep the stack when logging an unhandled rejection ([#1030](https://github.com/thefalconry/talon/issues/1030)) ([a82e348](https://github.com/thefalconry/talon/commit/a82e34811552168e9906a03aaf7589a3db1c5914))
* **mcp-hub:** don't evict MCP children when the bridge is busy, only when it's gone ([#1029](https://github.com/thefalconry/talon/issues/1029)) ([307b98f](https://github.com/thefalconry/talon/commit/307b98f0eddca85dd08faf03e8324e524c5467f8))


### Miscellaneous Chores

* **deps-dev:** Bump the dev-dependencies group with 2 updates ([#1026](https://github.com/thefalconry/talon/issues/1026)) ([2e1dded](https://github.com/thefalconry/talon/commit/2e1dded47d2b8e95699a75777857ef12c342cc01))
* **deps:** Bump tsx in the production-dependencies group ([#1027](https://github.com/thefalconry/talon/issues/1027)) ([7f91e5f](https://github.com/thefalconry/talon/commit/7f91e5f2e50af0de1f0273faff9211d5f4bf8712))

## [5.10.0](https://github.com/thefalconry/talon/compare/v5.9.0...v5.10.0) (2026-09-23)


### Features

* **agy:** real plan usage from `agy /usage` ([#1024](https://github.com/thefalconry/talon/issues/1024)) ([96622af](https://github.com/thefalconry/talon/commit/96622af485e6312ca84eed1c427311e64a86d524))

## [5.9.0](https://github.com/thefalconry/talon/compare/v5.8.0...v5.9.0) (2026-09-23)


### Features

* **prompts:** nuance the Freedom section — respect and listen, own corrections, provenance ([#1003](https://github.com/thefalconry/talon/issues/1003)) ([d891e6f](https://github.com/thefalconry/talon/commit/d891e6fbebef21d704918803e4927099d4fd4825))

## [5.8.0](https://github.com/thefalconry/talon/compare/v5.7.0...v5.8.0) (2026-09-23)


### Features

* **release:** Fedora .rpm packages and a server-only install guide ([#1020](https://github.com/thefalconry/talon/issues/1020)) ([1a3053e](https://github.com/thefalconry/talon/commit/1a3053efbbfe793d0c6225183cb29644c35f51d0))

## [5.7.0](https://github.com/thefalconry/talon/compare/v5.6.0...v5.7.0) (2026-09-23)


### Features

* companion mTLS via reverse proxy, agy in Docker, TrueNAS support ([#1018](https://github.com/thefalconry/talon/issues/1018)) ([af75e59](https://github.com/thefalconry/talon/commit/af75e59e9120c9c4a5db20baa03f5284e71f17db))

## [5.6.0](https://github.com/thefalconry/talon/compare/v5.5.1...v5.6.0) (2026-09-23)


### Features

* **hub:** conversation-only tool scope for non-operator DMs ([#1015](https://github.com/thefalconry/talon/issues/1015)) ([681c9f7](https://github.com/thefalconry/talon/commit/681c9f78f62dbff9c69bfea63bef0fae675c88bd))


### Bug Fixes

* **telegram:** /memory is admin-only and DM-only ([#1016](https://github.com/thefalconry/talon/issues/1016)) ([2dc4b48](https://github.com/thefalconry/talon/commit/2dc4b48ce871eb0979dbf4d2a66f153ec7057a89))

## [5.5.1](https://github.com/thefalconry/talon/compare/v5.5.0...v5.5.1) (2026-09-22)


### Bug Fixes

* **telegram:** gate /commands and button presses behind the DM whitelist ([#1013](https://github.com/thefalconry/talon/issues/1013)) ([ba82511](https://github.com/thefalconry/talon/commit/ba8251104f2d73b116538c815181ef75bd4a91e6))


### Miscellaneous Chores

* **deps-dev:** Bump @types/node in the dev-dependencies group ([#1010](https://github.com/thefalconry/talon/issues/1010)) ([2ddb07d](https://github.com/thefalconry/talon/commit/2ddb07dfb11ae6db6fb8785ee1ec6c23115a9f86))
* **deps-dev:** Bump the dev-dependencies group with 2 updates ([#1006](https://github.com/thefalconry/talon/issues/1006)) ([445f624](https://github.com/thefalconry/talon/commit/445f624110811b450e096ae108a0592dabe61237))
* **deps:** Bump github/codeql-action from 4.38.0 to 4.38.1 ([#1008](https://github.com/thefalconry/talon/issues/1008)) ([957c4bb](https://github.com/thefalconry/talon/commit/957c4bb6d030715585630bf0dd673baa52cedd9c))
* **deps:** Bump the production-dependencies group with 3 updates ([#1011](https://github.com/thefalconry/talon/issues/1011)) ([114342a](https://github.com/thefalconry/talon/commit/114342ab450bf97e5bb124b3263effb15c3a222f))
* **deps:** Bump the production-dependencies group with 6 updates ([#1007](https://github.com/thefalconry/talon/issues/1007)) ([d7aa5ee](https://github.com/thefalconry/talon/commit/d7aa5ee49f20eb6cd2bbc7ecd2ffa2a914a35c61))

## [5.5.0](https://github.com/thefalconry/talon/compare/v5.4.1...v5.5.0) (2026-09-21)


### Features

* **router:** plan-aware backend routing for sub-agents, cron and the heartbeat ([#1001](https://github.com/thefalconry/talon/issues/1001)) ([51bb7ba](https://github.com/thefalconry/talon/commit/51bb7babddbbb7e7521371354fb2e33369ddd655))


### Bug Fixes

* **telegram:** render markdown headings as bold and &gt; runs as blockquotes ([#996](https://github.com/thefalconry/talon/issues/996)) ([fc5563f](https://github.com/thefalconry/talon/commit/fc5563fed119ea9297ab8d76bd1f0b5ab169ffa9))


### Documentation

* **identity:** the reasoning behind the living-world default ([#999](https://github.com/thefalconry/talon/issues/999)) ([c5fb1f0](https://github.com/thefalconry/talon/commit/c5fb1f07b849e9d44fd4d4d3adae82622c361c55))

## [5.4.1](https://github.com/thefalconry/talon/compare/v5.4.0...v5.4.1) (2026-09-21)


### Bug Fixes

* **daemon:** /restart and /update survive Bun dropping the SIGTERM handler ([#1002](https://github.com/thefalconry/talon/issues/1002)) ([08ae6e4](https://github.com/thefalconry/talon/commit/08ae6e45d82c5b964b1a48e0adbafa2179730293))

## [5.4.0](https://github.com/thefalconry/talon/compare/v5.3.0...v5.4.0) (2026-09-20)


### Features

* **agy:** Antigravity CLI backend at parity with the Claude SDK backend ([#998](https://github.com/thefalconry/talon/issues/998)) ([5b0cf07](https://github.com/thefalconry/talon/commit/5b0cf074856b45feb8c33468907d6da009decb16))

## [5.3.0](https://github.com/thefalconry/talon/compare/v5.2.2...v5.3.0) (2026-09-19)


### Features

* **backup:** backups, checkpoints and remote targets ([#993](https://github.com/thefalconry/talon/issues/993)) ([dbc5b0b](https://github.com/thefalconry/talon/commit/dbc5b0b05de658a78f2c0431168272a00ae8bbdb))

## [5.2.2](https://github.com/thefalconry/talon/compare/v5.2.1...v5.2.2) (2026-09-19)


### Bug Fixes

* **daemon:** a failed restart handoff is visible, verified, and recovered ([#994](https://github.com/thefalconry/talon/issues/994)) ([91a78d6](https://github.com/thefalconry/talon/commit/91a78d6e96b6b281609d1cddb859703567678dcb))
* **playwright:** re-pin @playwright/mcp to 0.0.56 and stop dependabot bumping it ([#991](https://github.com/thefalconry/talon/issues/991)) ([729e0c3](https://github.com/thefalconry/talon/commit/729e0c3be8fd755ee1e6ac69e9e282b20d3fa1dc))


### Miscellaneous Chores

* **deps-dev:** Bump the dev-dependencies group with 2 updates ([#992](https://github.com/thefalconry/talon/issues/992)) ([727988c](https://github.com/thefalconry/talon/commit/727988ce23386802fbf34b674c4d74a0cda0c0e5))

## [5.2.1](https://github.com/thefalconry/talon/compare/v5.2.0...v5.2.1) (2026-09-18)


### Bug Fixes

* **log:** a full disk pauses file logging instead of killing the daemon ([#989](https://github.com/thefalconry/talon/issues/989)) ([48e3861](https://github.com/thefalconry/talon/commit/48e3861db62d3e9296f06f2a38e368ea0a6c75e4))

## [5.2.0](https://github.com/thefalconry/talon/compare/v5.1.0...v5.2.0) (2026-09-18)


### Features

* **agents:** backend-agnostic sub-agents with mailboxes and wake-turn delivery ([#982](https://github.com/thefalconry/talon/issues/982)) ([0555535](https://github.com/thefalconry/talon/commit/0555535f141e56f3684bb2a3d5488ca3e178ccec))
* **cli:** the launcher prefers Bun when it is installed ([#981](https://github.com/thefalconry/talon/issues/981)) ([ae6b0b1](https://github.com/thefalconry/talon/commit/ae6b0b1f8843b9dee7fa6e20b5a9a30c986cc693))
* **prompts:** freedom is the core of the Talon identity ([#980](https://github.com/thefalconry/talon/issues/980)) ([b24145d](https://github.com/thefalconry/talon/commit/b24145dec5f61d6a10889725778846c16587cbb1))


### Bug Fixes

* **app:** frontends report started, not stopped, so boot completes at boot ([#987](https://github.com/thefalconry/talon/issues/987)) ([23949db](https://github.com/thefalconry/talon/commit/23949dbc465ab5db8a4be8629e52f236eb4b0258))
* **gateway:** make Gateway.start() single-flight so concurrent frontends share one bind ([#975](https://github.com/thefalconry/talon/issues/975)) ([3c9248d](https://github.com/thefalconry/talon/commit/3c9248d6d127167d60772eddc5ee5064ab23333e))
* **telegram:** stop /mesh printing bridge credentials into a group ([#974](https://github.com/thefalconry/talon/issues/974)) ([b0273c5](https://github.com/thefalconry/talon/commit/b0273c5cac4c8db7b6c83494f9337987ec4ff062))


### Miscellaneous Chores

* **deps-dev:** Bump the dev-dependencies group with 4 updates ([#983](https://github.com/thefalconry/talon/issues/983)) ([2f8d229](https://github.com/thefalconry/talon/commit/2f8d229720efed8e7a77d70c7a8102e8f2c3b3a6))
* **deps:** Bump the production-dependencies group with 2 updates ([#984](https://github.com/thefalconry/talon/issues/984)) ([775d2cc](https://github.com/thefalconry/talon/commit/775d2cc0663ea2b5fcf9482996ca7eb2225acce0))
* **docker:** run the image on Bun, Node as a build-arg fallback ([#986](https://github.com/thefalconry/talon/issues/986)) ([fdd5229](https://github.com/thefalconry/talon/commit/fdd52293ea1b08eb3304d8a189e270b3506e1e05))


### Code Refactoring

* **backend:** kilo and opencode become remote-server profiles ([#972](https://github.com/thefalconry/talon/issues/972)) ([c7a290d](https://github.com/thefalconry/talon/commit/c7a290da4c6caf7b2c4c5bcdc054a01ac387e31d))
* **mesh:** tree core/mesh into devices/, links/, transfers/; name common.ts ([#971](https://github.com/thefalconry/talon/issues/971)) ([c98bbbc](https://github.com/thefalconry/talon/commit/c98bbbc4683e98fa53c33a998c55769b079b4428))


### Tests

* **openai-agents:** prove builtin dispatch with Read, not a shell spawn ([#988](https://github.com/thefalconry/talon/issues/988)) ([ae10222](https://github.com/thefalconry/talon/commit/ae10222b05f42fad5c38f36e45a300d77155cfb4))

## [5.1.0](https://github.com/thefalconry/talon/compare/v5.0.1...v5.1.0) (2026-09-18)


### Features

* **backend:** one-shot runs surface assistant text through onAssistantText ([#979](https://github.com/thefalconry/talon/issues/979)) ([0ed8a06](https://github.com/thefalconry/talon/commit/0ed8a0636e1408bf25359f079c9e76782b746112))


### Bug Fixes

* **claude-sdk:** an interrupted turn is a stop, not an SDK error ([#976](https://github.com/thefalconry/talon/issues/976)) ([48e6d1e](https://github.com/thefalconry/talon/commit/48e6d1ee5d1bc99a7199f69f8e182cb3c071a690))
* **mcp-hub:** render hub child keys readably in log lines ([#973](https://github.com/thefalconry/talon/issues/973)) ([9507a58](https://github.com/thefalconry/talon/commit/9507a5853366bb0a0164e13aa1fb02c333950028))


### Miscellaneous Chores

* **claude-sdk:** bump to 0.3.277 and name startup failures ([#978](https://github.com/thefalconry/talon/issues/978)) ([f13d144](https://github.com/thefalconry/talon/commit/f13d144aa5c91b34320439c610f0dcea96cf4918))

## [5.0.1](https://github.com/thefalconry/talon/compare/v5.0.0...v5.0.1) (2026-09-18)


### Bug Fixes

* **companion:** disable Impeller to dodge Pixel 10 / Android 17 beta crash-loop ([#964](https://github.com/thefalconry/talon/issues/964)) ([4fff816](https://github.com/thefalconry/talon/commit/4fff816bd09467c8e3bc4d582c70afb12c30ee23))


### Documentation

* the agent host sidecar — the Claude Agent SDK in its own process ([#967](https://github.com/thefalconry/talon/issues/967)) ([e8d02ff](https://github.com/thefalconry/talon/commit/e8d02ff95f0c76876cee01c0de2fd5325deafa99))


### Code Refactoring

* **agent-host:** the AgentHostClient seam and its protocol fixtures ([#968](https://github.com/thefalconry/talon/issues/968)) ([41e3b0c](https://github.com/thefalconry/talon/commit/41e3b0c1d11615a1d840b7d9977315abd157e8e2))
* **frontend:** one report renderer for Discord and Telegram; frontend/shared → presentation ([#965](https://github.com/thefalconry/talon/issues/965)) ([24e75b4](https://github.com/thefalconry/talon/commit/24e75b47af1389777fadaa5555971029c307f86a))
* **gateway-actions:** split native.ts by concern ([#970](https://github.com/thefalconry/talon/issues/970)) ([7155dfa](https://github.com/thefalconry/talon/commit/7155dfaeea5c4f874896ca0a57033428a860016f))
* **tools:** group the tool catalogue into chat/, ops/, content/ ([#963](https://github.com/thefalconry/talon/issues/963)) ([462afd7](https://github.com/thefalconry/talon/commit/462afd717e056e88966ec062e00454da3ae8147d))
* **util:** move the non-leaf modules to the subsystems that own them ([#966](https://github.com/thefalconry/talon/issues/966)) ([2d247cf](https://github.com/thefalconry/talon/commit/2d247cf1d082bad98d9ba6565356259d5539cb59))

## [5.0.0](https://github.com/thefalconry/talon/compare/v4.6.1...v5.0.0) (2026-09-18)


### ⚠ BREAKING CHANGES

* **memory:** remove the soul kernel; message taps feed the memory store ([#953](https://github.com/thefalconry/talon/issues/953))

### Features

* **memory:** turn-time retrieval from the store behind TALON_MEMORY_STORE ([#952](https://github.com/thefalconry/talon/issues/952)) ([8d5694b](https://github.com/thefalconry/talon/commit/8d5694b1bd07760fc4c3351d99573e78c536a51a))
* **metrics:** boot, resident-memory and per-turn CPU accounting ([#961](https://github.com/thefalconry/talon/issues/961)) ([2579d2c](https://github.com/thefalconry/talon/commit/2579d2c91955c272e897292346fb5e31fe5e9ad8))
* **metrics:** roll up prompt-cache verdicts, compaction boundaries and last-turn age ([#954](https://github.com/thefalconry/talon/issues/954)) ([6e05bd8](https://github.com/thefalconry/talon/commit/6e05bd823ab13953516bb9e6dc3d0936693a0462))
* **tools:** remember, recall and forget over the memory store ([#948](https://github.com/thefalconry/talon/issues/948)) ([c743cbe](https://github.com/thefalconry/talon/commit/c743cbe03c9c31dabd8bf79e518850e05a2992c5))


### Documentation

* cache economics plan — shared prefix, cold-session compaction ([#950](https://github.com/thefalconry/talon/issues/950)) ([7137c76](https://github.com/thefalconry/talon/commit/7137c767802967ee0b93707295fb8052b01e6f31))
* **cache:** compact while warm, infer the TTL, verify the boundary ([#955](https://github.com/thefalconry/talon/issues/955)) ([503d026](https://github.com/thefalconry/talon/commit/503d026c0f4e8a7116cb08beb9723b6b9abb1531))
* **lang:** boundaries before rewrites — the per-component verdict ([#957](https://github.com/thefalconry/talon/issues/957)) ([959638f](https://github.com/thefalconry/talon/commit/959638f203f19927589df2f1bdf3660943695f07))


### Miscellaneous Chores

* **tree:** the tree contract and its ratchet ([#956](https://github.com/thefalconry/talon/issues/956)) ([26af41f](https://github.com/thefalconry/talon/commit/26af41fe448a420b297fc415d3dc6a674d9cbb5b))


### Code Refactoring

* **backend:** backend/shared → backend/runtime with turn/, prompt/, cache/ ([#962](https://github.com/thefalconry/talon/issues/962)) ([5fec736](https://github.com/thefalconry/talon/commit/5fec73692561d41210dce417dc769c6f51b39a50))
* **core:** tree background/ into cron/, dream/, pulse/; fold scripting/ into scripts/ ([#959](https://github.com/thefalconry/talon/issues/959)) ([4c4893a](https://github.com/thefalconry/talon/commit/4c4893acb942e7f2ebeb316bb9257b430dddf1a2))
* **memory:** remove the soul kernel; message taps feed the memory store ([#953](https://github.com/thefalconry/talon/issues/953)) ([c996377](https://github.com/thefalconry/talon/commit/c9963773993d2be41e401847081c650492c22217))
* **native:** tree the bridge frontend into bridge/, chats/, turn/, surface/, media/ ([#960](https://github.com/thefalconry/talon/issues/960)) ([f500306](https://github.com/thefalconry/talon/commit/f500306568032cfa3032c50091565a69b013b095))
* **whatsapp:** tree the frontend into connection/ and messages/ ([#958](https://github.com/thefalconry/talon/issues/958)) ([8518113](https://github.com/thefalconry/talon/commit/8518113b99e2f7c04d3a64dfbc003ef44bd67492))


### Tests

* **native:** cover the turn, chat-lifecycle and handler seams ([#949](https://github.com/thefalconry/talon/issues/949)) ([3bbd0f7](https://github.com/thefalconry/talon/commit/3bbd0f7b75d2e36fa978f8fdf4b5f0bae526194c))

## [4.6.1](https://github.com/thefalconry/talon/compare/v4.6.0...v4.6.1) (2026-09-18)


### Miscellaneous Chores

* **lint:** zero warnings, and fail the gate on any new one ([#944](https://github.com/thefalconry/talon/issues/944)) ([937dd64](https://github.com/thefalconry/talon/commit/937dd6403c7d6210e30450ba326ad85169c8f21d))
* **ratchets:** function-size tooth 2 — 150 lines / complexity 25 ([#946](https://github.com/thefalconry/talon/issues/946)) ([91659d0](https://github.com/thefalconry/talon/commit/91659d07e90fc9dcd2711cb31b9a805333553920))

## [4.6.0](https://github.com/thefalconry/talon/compare/v4.5.0...v4.6.0) (2026-09-18)


### Features

* **prompt:** store-rendered memory core view behind TALON_MEMORY_STORE ([#943](https://github.com/thefalconry/talon/issues/943)) ([b013292](https://github.com/thefalconry/talon/commit/b013292318430ef3fc6e06243197aa21a8390461))

## [4.5.0](https://github.com/thefalconry/talon/compare/v4.4.0...v4.5.0) (2026-09-18)


### Features

* **memory:** /memory in Telegram and the native bridge ([#941](https://github.com/thefalconry/talon/issues/941)) ([d57a471](https://github.com/thefalconry/talon/commit/d57a4713e61cbec34694795b8d7c06e0a7924ff7))
* **memory:** import memory.md and daily notes into the store, render them back ([#940](https://github.com/thefalconry/talon/issues/940)) ([24e9488](https://github.com/thefalconry/talon/commit/24e9488d784850b680c8e5da17d7c6da05bd92fc))

## [4.4.0](https://github.com/thefalconry/talon/compare/v4.3.3...v4.4.0) (2026-09-18)


### Features

* **storage:** typed memory store with FTS5 ([#937](https://github.com/thefalconry/talon/issues/937)) ([c9d89c3](https://github.com/thefalconry/talon/commit/c9d89c3309480c289be3cf1ddc5e96d2982e2e36))


### Code Refactoring

* **core:** move engine configuration from util/config to core/config ([#936](https://github.com/thefalconry/talon/issues/936)) ([784139e](https://github.com/thefalconry/talon/commit/784139e395ee22efdb103ab728593e09d4bf26ee))
* **telegram:** name the two shared helper files by what they hold ([#939](https://github.com/thefalconry/talon/issues/939)) ([7119b6f](https://github.com/thefalconry/talon/commit/7119b6f0ad193d749017092bee80ab6d960b344c))

## [4.3.3](https://github.com/thefalconry/talon/compare/v4.3.2...v4.3.3) (2026-09-18)


### Code Refactoring

* **core:** move doctor, notify and pairing-broker out of the core root ([#931](https://github.com/thefalconry/talon/issues/931)) ([e3dc8fa](https://github.com/thefalconry/talon/commit/e3dc8fa10eb792b85c779c96d2c11e05f34abe5c))
* **telegram:** dispatch tables for callbacks, admin, moderation and middleware ([#935](https://github.com/thefalconry/talon/issues/935)) ([9e1401a](https://github.com/thefalconry/talon/commit/9e1401ab687c759fc534bac19ef4bf6d6c2cc2c4))
* **terminal:** split builtin commands and input closure into modules ([#932](https://github.com/thefalconry/talon/issues/932)) ([b6c1454](https://github.com/thefalconry/talon/commit/b6c1454990d161fea0dfad7e70728541d7fecceb))


### Tests

* **mcp-hub:** run child-exit fixtures with --no-warnings ([#930](https://github.com/thefalconry/talon/issues/930)) ([50ea87a](https://github.com/thefalconry/talon/commit/50ea87abe6324a831274c9d6bef65cbd8dcb4841))

## [4.3.2](https://github.com/thefalconry/talon/compare/v4.3.1...v4.3.2) (2026-09-18)


### Miscellaneous Chores

* **deps-dev:** Bump the dev-dependencies group with 2 updates ([#926](https://github.com/thefalconry/talon/issues/926)) ([9fb2c34](https://github.com/thefalconry/talon/commit/9fb2c34944843238e3aa91f9f7075596f828da69))
* **deps:** Bump the production-dependencies group with 2 updates ([#927](https://github.com/thefalconry/talon/issues/927)) ([f69e8c8](https://github.com/thefalconry/talon/commit/f69e8c81c8eda7bb030b03b45f0a4faf8789946e))


### Code Refactoring

* name storage stores and shared helper files by what they hold ([#929](https://github.com/thefalconry/talon/issues/929)) ([4afcb00](https://github.com/thefalconry/talon/commit/4afcb00d2ee5ea60ef2e21aac8b61554e6a724e7))
* **teams:** split the frontend closure into runtime + modules ([#928](https://github.com/thefalconry/talon/issues/928)) ([963fb78](https://github.com/thefalconry/talon/commit/963fb7809e138dcb9e8aa74c25664ba2a302caf5))

## [4.3.1](https://github.com/thefalconry/talon/compare/v4.3.0...v4.3.1) (2026-09-17)


### Bug Fixes

* **gateway:** route cron jobs and triggers by the chat's canonical string id ([#923](https://github.com/thefalconry/talon/issues/923)) ([1c200a1](https://github.com/thefalconry/talon/commit/1c200a13965e0f06395dfca2e688637d2631be96))

## [4.3.0](https://github.com/thefalconry/talon/compare/v4.2.0...v4.3.0) (2026-09-17)


### Features

* **relay:** fold cross-chat replies into the sending chat's next turn ([#918](https://github.com/thefalconry/talon/issues/918)) ([977d487](https://github.com/thefalconry/talon/commit/977d487958bee543ca76a2b27659b011f21401ac))


### Bug Fixes

* **mesh:** bound streamed device transfers so a stalled one can't wedge a chat ([#900](https://github.com/thefalconry/talon/issues/900)) ([d5a9d7c](https://github.com/thefalconry/talon/commit/d5a9d7c824f4c879bdd76469d0c8d0d7870837a5))
* **plugins:** bump native runtime pins (mempalace 3.10.0,github-mcp v1.12.2) ([#901](https://github.com/thefalconry/talon/issues/901)) ([38812a0](https://github.com/thefalconry/talon/commit/38812a08f3bbe349b3537c65792aea4c58bc6f32))


### Miscellaneous Chores

* **deps:** Bump @clack/prompts from 1.8.0 to 1.8.1 in the production-dependencies group ([#915](https://github.com/thefalconry/talon/issues/915)) ([1dd22ed](https://github.com/thefalconry/talon/commit/1dd22ed1618aa3b2974d055ad42cd10786671b4b))

## [4.2.0](https://github.com/thefalconry/talon/compare/v4.1.0...v4.2.0) (2026-09-17)


### Features

* **companion:** the app updates itself ([#920](https://github.com/thefalconry/talon/issues/920)) ([37a4b8c](https://github.com/thefalconry/talon/commit/37a4b8c26d16872ef5efd5051e2922be84a3fa1b))

## [4.1.0](https://github.com/thefalconry/talon/compare/v4.0.1...v4.1.0) (2026-09-17)


### Features

* **send_via:** carry media across frontends ([#916](https://github.com/thefalconry/talon/issues/916)) ([d50b788](https://github.com/thefalconry/talon/commit/d50b788f472bfab9cd2597705230bdff895d8ec1))
* **whatsapp:** manage the bot's own account from any frontend ([#917](https://github.com/thefalconry/talon/issues/917)) ([dfbbebd](https://github.com/thefalconry/talon/commit/dfbbebd2736bcff73fc33b430630211309c9c52d))

## [4.0.1](https://github.com/thefalconry/talon/compare/v4.0.0...v4.0.1) (2026-09-16)


### Bug Fixes

* **ci:** give npm propagation ten minutes, and bypass the cached miss ([#914](https://github.com/thefalconry/talon/issues/914)) ([26b0bca](https://github.com/thefalconry/talon/commit/26b0bca1ce5eb28d6a4e6a12414b9e4fda4236da))


### Miscellaneous Chores

* drop the 4.0.0 release-as pin ([#912](https://github.com/thefalconry/talon/issues/912)) ([1b34788](https://github.com/thefalconry/talon/commit/1b3478815672aa14859e3a6223dd93269b6c4788))

## [4.0.0](https://github.com/thefalconry/talon/compare/v3.37.0...v4.0.0) (2026-09-16)


### Bug Fixes

* **ci:** poll the npm registry in the release smoke test ([#909](https://github.com/thefalconry/talon/issues/909)) ([b6691be](https://github.com/thefalconry/talon/commit/b6691bee722983cfd83a9c283d3455e76d40dfce))


### Miscellaneous Chores

* cut the next release as 4.0.0 ([#910](https://github.com/thefalconry/talon/issues/910)) ([507009a](https://github.com/thefalconry/talon/commit/507009a80854c3f6486fc5f1b1cbcb712a1f0591))
* **deps:** Bump the production-dependencies group across 1 directory with 4 updates ([#908](https://github.com/thefalconry/talon/issues/908)) ([bbbc4fa](https://github.com/thefalconry/talon/commit/bbbc4faa0117ae4270e44dc01e03b500b55beee8))

## [3.37.0](https://github.com/thefalconry/talon/compare/v3.36.0...v3.37.0) (2026-09-16)


### Features

* **companion:** upload attachments as they are staged, not on send ([#907](https://github.com/thefalconry/talon/issues/907)) ([912d08f](https://github.com/thefalconry/talon/commit/912d08f84abd1522a19798a318ba5037efea63d6))


### Bug Fixes

* **dispatcher:** stop the typing loop after three consecutive failures ([#903](https://github.com/thefalconry/talon/issues/903)) ([e2a3e26](https://github.com/thefalconry/talon/commit/e2a3e260a17bddfb1f9c417270f22138d1d64100))
* **native:** log uploads and dropped attachment references ([#906](https://github.com/thefalconry/talon/issues/906)) ([8a607ce](https://github.com/thefalconry/talon/commit/8a607ce0e23f2f732f4393e3a610e5ba2feb0994))
* **playwright:** keep the MCP endpoint config out of /tmp and self-heal it ([#902](https://github.com/thefalconry/talon/issues/902)) ([1dc4d95](https://github.com/thefalconry/talon/commit/1dc4d9543ab3cde02bbb8fee78edfe230d35243e))
* **plugin:** re-evaluate path-plugin modules on hot reload ([#904](https://github.com/thefalconry/talon/issues/904)) ([a0ca8d8](https://github.com/thefalconry/talon/commit/a0ca8d8bc9571e4d626c2dd86321806f70aae393))

## [3.36.0](https://github.com/thefalconry/talon/compare/v3.35.0...v3.36.0) (2026-09-15)


### Features

* **companion:** attach any file type, several per message, with desktop drag and drop ([#897](https://github.com/thefalconry/talon/issues/897)) ([99dea04](https://github.com/thefalconry/talon/commit/99dea0436614cfdff2680fe1eb311885ef352082))

## [3.35.0](https://github.com/thefalconry/talon/compare/v3.34.1...v3.35.0) (2026-09-15)


### Features

* **auth:** let admins re-sign in to Claude and Codex from Telegram ([#886](https://github.com/thefalconry/talon/issues/886)) ([4dbbf37](https://github.com/thefalconry/talon/commit/4dbbf37ea5cd86baaee8e5251b85a1de4cf3eb6d))
* **whatsapp:** /model, /effort, /settings and /status text commands ([#891](https://github.com/thefalconry/talon/issues/891)) ([5fa1178](https://github.com/thefalconry/talon/commit/5fa11788118f535469ec1eb6e2776552cb00118a))
* **whatsapp:** chat history search, retrieval and persisted message keys ([#893](https://github.com/thefalconry/talon/issues/893)) ([4a369a3](https://github.com/thefalconry/talon/commit/4a369a34f67359849426c777a0fe70e9d74fcdbd))


### Bug Fixes

* **codex:** classify an expired OAuth login as an auth error, not a silent exit ([#883](https://github.com/thefalconry/talon/issues/883)) ([5957f55](https://github.com/thefalconry/talon/commit/5957f55fea9e5e7e334a29655b7f0b310650c38e))
* **remote-server:** abort in-flight turns when the server is stopped ([#882](https://github.com/thefalconry/talon/issues/882)) ([ca1f786](https://github.com/thefalconry/talon/commit/ca1f786277c5cc9a2d8775594e8d875c4725406c))
* **telegram:** stop /whatsapp and /auth being shadowed by the unknown-command catch-all ([#895](https://github.com/thefalconry/talon/issues/895)) ([679b7be](https://github.com/thefalconry/talon/commit/679b7be9a9933c0eec08e6d2aa76b446d3e57c54))


### Miscellaneous Chores

* add the MIT LICENSE and remove sponsorship links ([#890](https://github.com/thefalconry/talon/issues/890)) ([d73d724](https://github.com/thefalconry/talon/commit/d73d7240ec0b0c369e0b574980ffd5da0487a4a2))
* **deps-dev:** Bump the dev-dependencies group with 3 updates ([#887](https://github.com/thefalconry/talon/issues/887)) ([c8fc561](https://github.com/thefalconry/talon/commit/c8fc561534dddeef1e034db65892ef4db780f664))
* **deps:** Bump github/codeql-action from 4.37.9 to 4.38.0 ([#888](https://github.com/thefalconry/talon/issues/888)) ([f244d16](https://github.com/thefalconry/talon/commit/f244d16aa0f0db601c0b8e1d1f69f52e08b35591))
* **deps:** Bump the production-dependencies group with 8 updates ([#889](https://github.com/thefalconry/talon/issues/889)) ([4b30abb](https://github.com/thefalconry/talon/commit/4b30abb94912adaeac912c2571bbdbc8283c4011))

## [3.34.1](https://github.com/thefalconry/talon/compare/v3.34.0...v3.34.1) (2026-09-14)


### Bug Fixes

* **log:** latch the repeated cache-minimum and invalid-override warnings ([#878](https://github.com/thefalconry/talon/issues/878)) ([5ad7d82](https://github.com/thefalconry/talon/commit/5ad7d82ea48a181a4d969e1a0bbda73a3c1b929b))
* **mcp-hub:** log hub child exit code, signal and stderr tail ([#885](https://github.com/thefalconry/talon/issues/885)) ([ca15f1a](https://github.com/thefalconry/talon/commit/ca15f1aab816f3f66a4ad4db4853fac47b63ae64))
* **remote-server:** keep plugin MCP tool ids under Anthropic's 64-char limit ([#881](https://github.com/thefalconry/talon/issues/881)) ([1e04de1](https://github.com/thefalconry/talon/commit/1e04de1f6825a58994f13c58d323cc06046a690e))
* **telegram:** chunk the /admin chats, cron, and pulse listings ([#879](https://github.com/thefalconry/talon/issues/879)) ([51a51da](https://github.com/thefalconry/talon/commit/51a51da96b2b334457bc870bb7c918282f2cb5a2))
* **triggers:** skip terminal wakes during shutdown and defer them to next boot ([#880](https://github.com/thefalconry/talon/issues/880)) ([819de52](https://github.com/thefalconry/talon/commit/819de5294c066aa7f25e3900a7d410bce2e89a33))
* **watchdog:** measure wedge silence from turn activity, not turn length ([#877](https://github.com/thefalconry/talon/issues/877)) ([0e433b7](https://github.com/thefalconry/talon/commit/0e433b7d2fe8e244b844e86d906f20cf21608f2d))
* **whatsapp:** install link-preview-js so baileys link previews work ([#876](https://github.com/thefalconry/talon/issues/876)) ([1ac2a12](https://github.com/thefalconry/talon/commit/1ac2a12304d6e974a4cfcb1716f190542ad10507))


### Code Refactoring

* **backend:** share the post-stream turn phases across backends ([#867](https://github.com/thefalconry/talon/issues/867)) ([542d073](https://github.com/thefalconry/talon/commit/542d0736c1a73f84a13a67a8d07aa72645387c4b))
* **remote-server:** hoist the model presentation renderers out of the factory ([#869](https://github.com/thefalconry/talon/issues/869)) ([19598ba](https://github.com/thefalconry/talon/commit/19598ba036f1a7dfeecd9d362aa2cb295a101a94))

## [3.34.0](https://github.com/thefalconry/talon/compare/v3.33.4...v3.34.0) (2026-09-14)


### Features

* **metrics:** time each turn phase and each boot phase ([#861](https://github.com/thefalconry/talon/issues/861)) ([229bead](https://github.com/thefalconry/talon/commit/229beadda2761bad7407892aac091ba4a49fafcb))


### Performance Improvements

* **boot:** reconcile per-chat bindings concurrently and dedupe pool inits ([#863](https://github.com/thefalconry/talon/issues/863)) ([a727698](https://github.com/thefalconry/talon/commit/a72769804b0f2802fdfec58254e746fcd2918b42))


### Documentation

* cleanup plan + function-size ratchet ([#859](https://github.com/thefalconry/talon/issues/859)) ([f3fd6c0](https://github.com/thefalconry/talon/commit/f3fd6c0e153854d0fa3d9b7ccd3a27f1a222b4bb))


### Miscellaneous Chores

* **deps:** Bump the production-dependencies group with 4 updates ([#858](https://github.com/thefalconry/talon/issues/858)) ([97a3a4d](https://github.com/thefalconry/talon/commit/97a3a4de5050f6b3412374e02ccbb160cdf8fdfa))


### Code Refactoring

* **backend:** name the SSE session-error and SDK result readers ([#873](https://github.com/thefalconry/talon/issues/873)) ([e33a329](https://github.com/thefalconry/talon/commit/e33a329b7d36a25575925f67f04c61a2074d077a))
* **cli:** split the setup wizard into steps ([#860](https://github.com/thefalconry/talon/issues/860)) ([af2ea08](https://github.com/thefalconry/talon/commit/af2ea08768411f1ef274b202763ed473972894ec))
* **core:** split the heartbeat run and the VFS file mount ([#870](https://github.com/thefalconry/talon/issues/870)) ([902815b](https://github.com/thefalconry/talon/commit/902815b72e7303f0cbf23b6454010680f76fc3d6))
* **cron:** parse the schedule spec once for create and edit ([#864](https://github.com/thefalconry/talon/issues/864)) ([73ff8cf](https://github.com/thefalconry/talon/commit/73ff8cfe76a7a544474f56d7316a6f635392fded))
* **discord:** split the frontend closure and table-dispatch component interactions ([#868](https://github.com/thefalconry/talon/issues/868)) ([c49e5a7](https://github.com/thefalconry/talon/commit/c49e5a78bc6ca3c8e1b8fe2fc379b79de3bf96bf))
* **gateway:** declare the action gateway's routes in one table ([#866](https://github.com/thefalconry/talon/issues/866)) ([7049626](https://github.com/thefalconry/talon/commit/7049626f4a65def0b037239efed2be9efbe5e74b))
* **native:** move the bridge's route handlers into route-group modules ([#874](https://github.com/thefalconry/talon/issues/874)) ([6c8bf38](https://github.com/thefalconry/talon/commit/6c8bf384d8c2a70dab783eb0883c45aca8499e5d))
* **native:** split the frontend closure into runtime + modules ([#862](https://github.com/thefalconry/talon/issues/862)) ([f28ea1c](https://github.com/thefalconry/talon/commit/f28ea1c82d414fe81ae585ca54aa44601e588992))
* **whatsapp:** split the frontend closure into runtime + modules ([#875](https://github.com/thefalconry/talon/issues/875)) ([6de89a5](https://github.com/thefalconry/talon/commit/6de89a53b68648ad1f5a09f97770b9d585aebcf6))

## [3.33.4](https://github.com/thefalconry/talon/compare/v3.33.3...v3.33.4) (2026-09-14)


### Bug Fixes

* **plugins:** bump native runtime pins (github-mcp v1.12.1) ([#854](https://github.com/thefalconry/talon/issues/854)) ([eb703e2](https://github.com/thefalconry/talon/commit/eb703e2149129cdf06933a7374a419654a1e6867))


### Miscellaneous Chores

* **deps-dev:** Bump the dev-dependencies group across 1 directory with 3 updates ([#857](https://github.com/thefalconry/talon/issues/857)) ([afae82e](https://github.com/thefalconry/talon/commit/afae82e60540e49970d04401a25725fd7635ec96))
* **deps-dev:** bump vitest and @vitest/coverage-v8 to 5.0.0 ([#851](https://github.com/thefalconry/talon/issues/851)) ([ee19738](https://github.com/thefalconry/talon/commit/ee19738af3bb8feddfc61b1eadd4788d80347163))
* **deps:** Bump hono from 4.13.0 to 4.13.7 ([#848](https://github.com/thefalconry/talon/issues/848)) ([578e369](https://github.com/thefalconry/talon/commit/578e369f6bb2ca65a54417fe1922c57130ee2451))
* **deps:** Bump sharp from 0.35.3 to 0.35.4 ([#849](https://github.com/thefalconry/talon/issues/849)) ([0e5c28b](https://github.com/thefalconry/talon/commit/0e5c28bb854516bdcb9bb96b1f27104656e2c7f0))
* **deps:** Bump the production-dependencies group with 2 updates ([#855](https://github.com/thefalconry/talon/issues/855)) ([2f1a006](https://github.com/thefalconry/talon/commit/2f1a00622d37b8e8617cd1f3225e784f9cc36d1a))


### Continuous Integration

* run kilo/opencode real-bootstrap suites in the Backend Live tier ([#852](https://github.com/thefalconry/talon/issues/852)) ([5832af8](https://github.com/thefalconry/talon/commit/5832af8aad7960843213e17e475794b6869ea661))

## [3.33.3](https://github.com/thefalconry/talon/compare/v3.33.2...v3.33.3) (2026-09-08)


### Code Refactoring

* **doctor:** compose backend checks from the registry ([#830](https://github.com/thefalconry/talon/issues/830)) ([e156db3](https://github.com/thefalconry/talon/commit/e156db3908c0ad73da1f43429eb123f67bc009c4))

## [3.33.2](https://github.com/thefalconry/talon/compare/v3.33.1...v3.33.2) (2026-09-08)


### Miscellaneous Chores

* **deps-dev:** Bump @swc/core in the dev-dependencies group ([#843](https://github.com/thefalconry/talon/issues/843)) ([5132134](https://github.com/thefalconry/talon/commit/513213412fb39dac02e1266470a591cd4db0b36a))
* **deps-dev:** Bump @types/node in the dev-dependencies group ([#839](https://github.com/thefalconry/talon/issues/839)) ([7cceac8](https://github.com/thefalconry/talon/commit/7cceac8203339b46d66340eeb2e5504a78b7ae2d))
* **deps-dev:** Bump the dev-dependencies group with 2 updates ([#837](https://github.com/thefalconry/talon/issues/837)) ([d2ba54a](https://github.com/thefalconry/talon/commit/d2ba54affbd18e6a39427316197e64e52a45926d))
* **deps:** Bump actions/setup-python from 6 to 7 ([#831](https://github.com/thefalconry/talon/issues/831)) ([91bd862](https://github.com/thefalconry/talon/commit/91bd8626fdcf8861fcbadfa41cbd1d0f9fbeda9c))
* **deps:** Bump fast-uri from 3.1.5 to 3.1.7 ([#833](https://github.com/thefalconry/talon/issues/833)) ([61661b7](https://github.com/thefalconry/talon/commit/61661b703cdaa833dc6bbc7f028d2dff983b99a0))
* **deps:** Bump qs from 6.15.3 to 6.16.0 ([#834](https://github.com/thefalconry/talon/issues/834)) ([27cdc6e](https://github.com/thefalconry/talon/commit/27cdc6ef4de2586beaefa0b273110c0663e6dc4b))
* **deps:** Bump the production-dependencies group with 2 updates ([#835](https://github.com/thefalconry/talon/issues/835)) ([76d5bf2](https://github.com/thefalconry/talon/commit/76d5bf2d1d794573bf086e5678a9381c7e4aa63f))
* **deps:** Bump the production-dependencies group with 2 updates ([#844](https://github.com/thefalconry/talon/issues/844)) ([8e86800](https://github.com/thefalconry/talon/commit/8e86800ec625a12362a81fe93b99b7e57924df06))
* **deps:** Bump the production-dependencies group with 4 updates ([#838](https://github.com/thefalconry/talon/issues/838)) ([1b9cbb4](https://github.com/thefalconry/talon/commit/1b9cbb4cf8988d9b272e6a385cd35e1e820a7d28))
* **deps:** Bump the production-dependencies group with 7 updates ([#840](https://github.com/thefalconry/talon/issues/840)) ([d4076da](https://github.com/thefalconry/talon/commit/d4076da20444e1e31e901cf775fbf060d1516093))
* **deps:** Bump tsx in the production-dependencies group ([#832](https://github.com/thefalconry/talon/issues/832)) ([affc336](https://github.com/thefalconry/talon/commit/affc3365feba8371e7119bc00fd46493c3d78b2a))


### Code Refactoring

* **companion:** split the settings screen into per-card widgets ([#829](https://github.com/thefalconry/talon/issues/829)) ([f9a9e85](https://github.com/thefalconry/talon/commit/f9a9e85569075cf081c7cb21a9c9837ae86c4e16))

## [3.33.1](https://github.com/thefalconry/talon/compare/v3.33.0...v3.33.1) (2026-09-02)


### Code Refactoring

* **backend:** make Kilo and OpenCode profiles of one remote-server backend ([#825](https://github.com/thefalconry/talon/issues/825)) ([ea4eeb4](https://github.com/thefalconry/talon/commit/ea4eeb4ec4c1a0e05dbac2a3c2d44d53ca329fa1))
* **frontend:** share the access-gate primitives across frontends ([#826](https://github.com/thefalconry/talon/issues/826)) ([9927b56](https://github.com/thefalconry/talon/commit/9927b5618a142eec7f382b57b25af45326bf2b7a))
* **mesh:** split file transfer and bridge links out of MeshService ([#827](https://github.com/thefalconry/talon/issues/827)) ([2ed648f](https://github.com/thefalconry/talon/commit/2ed648fed2cca9dd58db01c45bcb736c493c614a))
* **native:** declare the bridge's routes and their auth tier in one table ([#824](https://github.com/thefalconry/talon/issues/824)) ([7a6f634](https://github.com/thefalconry/talon/commit/7a6f6349d517786615c3942b770ef727854bcbba))

## [3.33.0](https://github.com/thefalconry/talon/compare/v3.32.1...v3.33.0) (2026-09-02)


### Features

* **companion:** name the connect fields and status pill for screen readers ([#759](https://github.com/thefalconry/talon/issues/759)) ([dcb3fec](https://github.com/thefalconry/talon/commit/dcb3fec290ddf41a57687ed51c4552ae8e34c9e5))


### Miscellaneous Chores

* **quality:** sweep 255 dead exports and gate knip in CI ([#820](https://github.com/thefalconry/talon/issues/820)) ([517ade3](https://github.com/thefalconry/talon/commit/517ade3e9659ebe5295947ae4a0676f0fb7eaf9a))


### Tests

* **plugins:** run the native-runtime suite under bun on every OS, through the MCP supervisor ([#801](https://github.com/thefalconry/talon/issues/801)) ([5ffdf3d](https://github.com/thefalconry/talon/commit/5ffdf3d4991b548aed529e2814eb1d23d31e62e3))

## [3.32.1](https://github.com/thefalconry/talon/compare/v3.32.0...v3.32.1) (2026-09-02)


### Bug Fixes

* **ci:** make the architecture gate actually cruise the codebase ([#817](https://github.com/thefalconry/talon/issues/817)) ([18290d5](https://github.com/thefalconry/talon/commit/18290d5b2f3cd3f7b08c2b94d5f1820c204e9f16))


### Miscellaneous Chores

* **deps:** Bump the production-dependencies group with 2 updates ([#818](https://github.com/thefalconry/talon/issues/818)) ([b625f32](https://github.com/thefalconry/talon/commit/b625f32f3fb79b44b444307bd0e5086bf6cceeb7))

## [3.32.0](https://github.com/thefalconry/talon/compare/v3.31.0...v3.32.0) (2026-09-01)


### Features

* **mesh:** one-tap device pairing via /mesh link ([#815](https://github.com/thefalconry/talon/issues/815)) ([3b18c34](https://github.com/thefalconry/talon/commit/3b18c34278112d17e1596aab6d79a58d6ee79523))

## [3.31.0](https://github.com/thefalconry/talon/compare/v3.30.0...v3.31.0) (2026-09-01)


### Features

* **companion:** root execution tier for device control ([#812](https://github.com/thefalconry/talon/issues/812)) ([c00a169](https://github.com/thefalconry/talon/commit/c00a169b6341ecdf99c4c7dbed7e96a8f97672ae))


### Bug Fixes

* **plugins:** bump native runtime pins (mempalace 3.9.0) ([#808](https://github.com/thefalconry/talon/issues/808)) ([f538646](https://github.com/thefalconry/talon/commit/f538646235857487dc6bc3051c2b2a33267daa16))


### Miscellaneous Chores

* **deps-dev:** Bump the dev-dependencies group with 2 updates ([#809](https://github.com/thefalconry/talon/issues/809)) ([4088006](https://github.com/thefalconry/talon/commit/4088006e82c22964d00f6b769bbc51b4dfbd6ee8))
* **deps:** Bump actions/setup-python from 6 to 7 ([754082c](https://github.com/thefalconry/talon/commit/754082c149e2bf57f5b562d9741b880957f9e3a8))
* **deps:** Bump github/codeql-action from 4.37.8 to 4.37.9 ([#810](https://github.com/thefalconry/talon/issues/810)) ([25688de](https://github.com/thefalconry/talon/commit/25688de6891aefdc5f987ba2dac1af1775467766))
* **deps:** Bump the production-dependencies group with 7 updates ([#811](https://github.com/thefalconry/talon/issues/811)) ([361b002](https://github.com/thefalconry/talon/commit/361b0024be83ab1e35e1b8d0f322c7200374c8e1))

## [3.30.0](https://github.com/thefalconry/talon/compare/v3.29.0...v3.30.0) (2026-08-30)


### Features

* **telegram:** blockedUsers denylist, dropped in silence ([#805](https://github.com/thefalconry/talon/issues/805)) ([dbaf892](https://github.com/thefalconry/talon/commit/dbaf8926fe32f7647f3081149a7de2727b9739bf))


### Bug Fixes

* **whatsapp:** a QR-linked session is not an unpaired one ([#806](https://github.com/thefalconry/talon/issues/806)) ([364ab80](https://github.com/thefalconry/talon/commit/364ab80ddb06494a88b26e2896a1350cb58b47b6))


### Miscellaneous Chores

* **deps-dev:** Bump @types/node in the dev-dependencies group ([#802](https://github.com/thefalconry/talon/issues/802)) ([1498178](https://github.com/thefalconry/talon/commit/1498178e2f387984ff595190c07b1f70045e4c47))
* **deps:** Bump the production-dependencies group with 2 updates ([#803](https://github.com/thefalconry/talon/issues/803)) ([667d8e1](https://github.com/thefalconry/talon/commit/667d8e1ceb88e6fdcaaf0f104de41e7f9a96fc57))

## [3.29.0](https://github.com/thefalconry/talon/compare/v3.28.1...v3.29.0) (2026-08-28)


### Features

* **plugins:** self-installing, self-healing native plugin runtimes ([#793](https://github.com/thefalconry/talon/issues/793)) ([7bdc301](https://github.com/thefalconry/talon/commit/7bdc30111d35dec318c469d93f1f2c10f8f013ad))

## [3.28.1](https://github.com/thefalconry/talon/compare/v3.28.0...v3.28.1) (2026-08-28)


### Miscellaneous Chores

* **deps-dev:** Bump oxlint in the dev-dependencies group ([#796](https://github.com/thefalconry/talon/issues/796)) ([b292196](https://github.com/thefalconry/talon/commit/b292196f6f33ad0d2c288332a324e5f36515702a))
* **deps:** Bump @anthropic-ai/claude-agent-sdk ([#794](https://github.com/thefalconry/talon/issues/794)) ([64fd394](https://github.com/thefalconry/talon/commit/64fd394e58b1930979bb024da856a9ead9a3ebe9))
* **deps:** Bump @anthropic-ai/claude-agent-sdk ([#795](https://github.com/thefalconry/talon/issues/795)) ([8a939bd](https://github.com/thefalconry/talon/commit/8a939bdb78946f131f04a081700a0aab2de7b95b))
* **deps:** Bump actions/setup-java from 5 to 6 ([bb990b8](https://github.com/thefalconry/talon/commit/bb990b89089706fe96ae5aa6f750d9d45a195ab6))
* **deps:** Bump actions/setup-java from 5 to 6 ([16983a5](https://github.com/thefalconry/talon/commit/16983a546d133433944637714efab0697ead84b4))
* **deps:** Bump github/codeql-action from 4.37.7 to 4.37.8 ([#792](https://github.com/thefalconry/talon/issues/792)) ([41e2027](https://github.com/thefalconry/talon/commit/41e2027471e77c92a1dfef64c1a5f94792aa2dd0))
* **deps:** Bump the production-dependencies group with 4 updates ([#798](https://github.com/thefalconry/talon/issues/798)) ([59683b9](https://github.com/thefalconry/talon/commit/59683b9f49a1d3f928abc7bfe0ead22352ef22f9))
* **deps:** Bump the production-dependencies group with 6 updates ([#791](https://github.com/thefalconry/talon/issues/791)) ([9779b38](https://github.com/thefalconry/talon/commit/9779b38f92367be71f1fdf4c93295ff995ac39c3))

## [3.28.0](https://github.com/thefalconry/talon/compare/v3.27.0...v3.28.0) (2026-08-23)


### Features

* **tools:** cross-frontend send — message any enabled frontend from any session ([#789](https://github.com/thefalconry/talon/issues/789)) ([2a25fd7](https://github.com/thefalconry/talon/commit/2a25fd7b82dd0c7f2739e050cc76dd58d2703399))


### Continuous Integration

* stop lockfile drift at its source — engine floors and a canonical-lock gate ([#787](https://github.com/thefalconry/talon/issues/787)) ([fa47cde](https://github.com/thefalconry/talon/commit/fa47cde9fd4f8e0f93966de5d1b6115bdce6d84c))

## [3.27.0](https://github.com/thefalconry/talon/compare/v3.26.0...v3.27.0) (2026-08-23)


### Features

* **whatsapp:** pair on demand from Telegram — /whatsapp sends the QR and code ([#786](https://github.com/thefalconry/talon/issues/786)) ([618ded2](https://github.com/thefalconry/talon/commit/618ded26faa6219d99bcb3c8d4c62def612a44ad))

## [3.26.0](https://github.com/thefalconry/talon/compare/v3.25.3...v3.26.0) (2026-08-23)


### Features

* **whatsapp:** harden the socket layer along OpenClaw's patterns ([#784](https://github.com/thefalconry/talon/issues/784)) ([783fc5b](https://github.com/thefalconry/talon/commit/783fc5b779b3f542b71ba9b7e0506f077d311406))

## [3.25.3](https://github.com/thefalconry/talon/compare/v3.25.2...v3.25.3) (2026-08-23)


### Bug Fixes

* **whatsapp:** continuous sessions — two-sided history, stable ids, offline catch-up, visible errors ([#781](https://github.com/thefalconry/talon/issues/781)) ([f6d5e65](https://github.com/thefalconry/talon/commit/f6d5e65f97f2d33bdccecf85147eca94a27ec0f0))
* **whatsapp:** stop the re-pairing loop burning a code every 2 minutes, and tell the admin ([#783](https://github.com/thefalconry/talon/issues/783)) ([cc6a949](https://github.com/thefalconry/talon/commit/cc6a949032f8cd290b1afe3cc72398ac496b49d7))

## [3.25.2](https://github.com/thefalconry/talon/compare/v3.25.1...v3.25.2) (2026-08-23)


### Bug Fixes

* **cli:** stop `talon setup` destroying config it never prompts for ([#779](https://github.com/thefalconry/talon/issues/779)) ([7f396aa](https://github.com/thefalconry/talon/commit/7f396aad629193048185e67528f0f15903c07dbe))

## [3.25.1](https://github.com/thefalconry/talon/compare/v3.25.0...v3.25.1) (2026-08-23)


### Miscellaneous Chores

* refresh README and remove files added by accident ([#777](https://github.com/thefalconry/talon/issues/777)) ([607502a](https://github.com/thefalconry/talon/commit/607502a2fbddda4051ba2a83e5c9d001e5ce4f0c))

## [3.25.0](https://github.com/thefalconry/talon/compare/v3.24.1...v3.25.0) (2026-08-22)


### Features

* **whatsapp:** WhatsApp frontend via Baileys multi-device ([#773](https://github.com/thefalconry/talon/issues/773)) ([a663223](https://github.com/thefalconry/talon/commit/a6632231a9c5506999d2d21c93b88613089fa675))

## [3.24.1](https://github.com/thefalconry/talon/compare/v3.24.0...v3.24.1) (2026-08-22)


### Bug Fixes

* **telegram:** stop a redelivered /restart from looping the daemon ([#774](https://github.com/thefalconry/talon/issues/774)) ([cf715f0](https://github.com/thefalconry/talon/commit/cf715f0bd17004b817d1ae44ba03a88b850399a3))

## [3.24.0](https://github.com/thefalconry/talon/compare/v3.23.1...v3.24.0) (2026-08-22)


### Features

* **status:** runtime info in /status, and a clean /stop ([#771](https://github.com/thefalconry/talon/issues/771)) ([cb65d95](https://github.com/thefalconry/talon/commit/cb65d95e6a21db5f112b0cbeaff5b5c3a0cf6c2a))

## [3.23.1](https://github.com/thefalconry/talon/compare/v3.23.0...v3.23.1) (2026-08-22)


### Bug Fixes

* **runtime:** make the test suite and runtime seams bun-clean ([#769](https://github.com/thefalconry/talon/issues/769)) ([7fd2236](https://github.com/thefalconry/talon/commit/7fd2236a01a5a1d276942f98227c88af03397181))

## [3.23.0](https://github.com/thefalconry/talon/compare/v3.22.1...v3.23.0) (2026-08-22)


### Features

* **runtime:** run source installs under Bun ([#767](https://github.com/thefalconry/talon/issues/767)) ([4a81e34](https://github.com/thefalconry/talon/commit/4a81e34f09690d4cdc28152e3f0d7382ed711d73))

## [3.22.1](https://github.com/thefalconry/talon/compare/v3.22.0...v3.22.1) (2026-08-22)


### Bug Fixes

* **companion:** treat a missing port as the scheme default, not 19880 ([768c9ea](https://github.com/thefalconry/talon/commit/768c9ea07209b17008cf0393ae409ee7c3709d5b))
* **companion:** treat a missing port as the scheme default, not 19880 ([4886e5c](https://github.com/thefalconry/talon/commit/4886e5cdc48ab0af1ff77445cd1f1813b4d4deda))
* harden runtime paths flagged by an all-time log audit ([#764](https://github.com/thefalconry/talon/issues/764)) ([f1d8370](https://github.com/thefalconry/talon/commit/f1d837009b5462d9f44f35b19c677cbab69819bf))


### Documentation

* long-term plan for migrating off TypeScript ([#765](https://github.com/thefalconry/talon/issues/765)) ([8f1860c](https://github.com/thefalconry/talon/commit/8f1860cd6508a802f60433e2aa79b0407f92897e))


### Miscellaneous Chores

* **deps-dev:** Bump the dev-dependencies group with 3 updates ([#762](https://github.com/thefalconry/talon/issues/762)) ([36a7ae2](https://github.com/thefalconry/talon/commit/36a7ae2b3f22041115a294abd29c709d812b1f1d))
* **deps:** Bump the production-dependencies group with 2 updates ([#761](https://github.com/thefalconry/talon/issues/761)) ([377dc15](https://github.com/thefalconry/talon/commit/377dc15abb390634d5ef23e99c3685968c39739a))
* **deps:** Bump the production-dependencies group with 2 updates ([#763](https://github.com/thefalconry/talon/issues/763)) ([2489ac9](https://github.com/thefalconry/talon/commit/2489ac96b7d2a9f035e4b14d4565b57f0ec50ed4))

## [3.22.0](https://github.com/thefalconry/talon/compare/v3.21.0...v3.22.0) (2026-08-19)


### Features

* **telegram:** albums, round video notes, and venues ([6afb27e](https://github.com/thefalconry/talon/commit/6afb27e683d96f0bee543ad820a0ed6eabc3cc55))
* **telegram:** bulk and cross-chat message ops, caption edits ([e61082a](https://github.com/thefalconry/talon/commit/e61082a91e3c2400040a09e927809473feea8a6d))
* **telegram:** forum topics, richer sends, bulk ops, and a moderation surface ([6a4f274](https://github.com/thefalconry/talon/commit/6a4f274eb283adb20bef1e98a5f6d016ba503ba0))
* **telegram:** moderation tool — members, invites, joins, topics ([14d2e3d](https://github.com/thefalconry/talon/commit/14d2e3d573760ee7f92aa94f5d513029ba04e600))
* **telegram:** route output into forum topics, add delivery modifiers ([62a18f7](https://github.com/thefalconry/talon/commit/62a18f73fc7e1b1e79f0d15efa2f6c50d166571d))


### Bug Fixes

* **userbot:** don't let a mid-probe shutdown trigger a reconnect ([d61bcbf](https://github.com/thefalconry/talon/commit/d61bcbf662d6e32705610ee9f022945d7eb72176))


### Miscellaneous Chores

* **deps:** raise grammy floor to ^1.45.1 ([f04816e](https://github.com/thefalconry/talon/commit/f04816e294ce23cc0eb2945acfed831c363de1b3))

## [3.21.0](https://github.com/thefalconry/talon/compare/v3.20.0...v3.21.0) (2026-08-19)


### Features

* **companion:** one shared empty state across logs, plugins and the chat list ([678575b](https://github.com/thefalconry/talon/commit/678575b6916e94f06435c00d0a06f8e32b0a43c8))


### Bug Fixes

* **cron:** fall back to the role backend when the chat's can't run isolated jobs ([3cc5bde](https://github.com/thefalconry/talon/commit/3cc5bdedf33772207111750def2604a6c71d1758))
* **cron:** only warn 'skipped' once a job is out of candidates ([69fcafb](https://github.com/thefalconry/talon/commit/69fcafba7983325012f4d32cda6aace71075b049))


### Miscellaneous Chores

* **deps:** Bump the production-dependencies group across 1 directory with 7 updates ([#752](https://github.com/thefalconry/talon/issues/752)) ([935b8e7](https://github.com/thefalconry/talon/commit/935b8e7356e1ce79d502fc973f2c48a2ff13c4cc))


### Code Refactoring

* **prompts:** one voice spec — dedupe base.md, warm up identity.md ([1560c54](https://github.com/thefalconry/talon/commit/1560c54f6a324f0dad6d1b6c30ca983fa24e87e9))

## [3.20.0](https://github.com/thefalconry/talon/compare/v3.19.1...v3.20.0) (2026-08-19)


### Features

* **chat:** add /stop for running turns ([5fad21d](https://github.com/thefalconry/talon/commit/5fad21d7550ccd707144f4478d1a4ff1fa8c517a))
* **chat:** add /stop for running turns ([e05c776](https://github.com/thefalconry/talon/commit/e05c7767047ecd101c3d327fc54494fba6cea9f3))
* **companion:** validate the connect form before dialling ([aca0cd1](https://github.com/thefalconry/talon/commit/aca0cd1b10ba2014c146425e035c4d4d7f9b840e))


### Bug Fixes

* **userbot:** use a real round-trip as the connection liveness probe ([8c617ff](https://github.com/thefalconry/talon/commit/8c617ff87db20d71d230abc5b3f8fd3d2b305eea))
* **userbot:** use a real round-trip as the connection liveness probe ([ce794b0](https://github.com/thefalconry/talon/commit/ce794b02dd84311a15ad6d65b6148483a4b98b26))


### Miscellaneous Chores

* **deps-dev:** Bump knip in the dev-dependencies group ([#749](https://github.com/thefalconry/talon/issues/749)) ([7600f5a](https://github.com/thefalconry/talon/commit/7600f5aae2e27c75cc6527ffaf9d63787bd98b60))
* **deps-dev:** Bump the dev-dependencies group with 2 updates ([#736](https://github.com/thefalconry/talon/issues/736)) ([c2f0c15](https://github.com/thefalconry/talon/commit/c2f0c15ee52f57644b07eeb99f8fb2d6f9dc1a38))
* **deps-dev:** Bump the dev-dependencies group with 2 updates ([#741](https://github.com/thefalconry/talon/issues/741)) ([0aa0a57](https://github.com/thefalconry/talon/commit/0aa0a57bd509b121136a8345d6ce862a9febda36))
* **deps-dev:** Bump the dev-dependencies group with 3 updates ([#744](https://github.com/thefalconry/talon/issues/744)) ([104ef8d](https://github.com/thefalconry/talon/commit/104ef8d4c6412b0a17df868b0e824600cb839b40))
* **deps:** Bump @anthropic-ai/claude-agent-sdk ([#743](https://github.com/thefalconry/talon/issues/743)) ([8d01076](https://github.com/thefalconry/talon/commit/8d010762c1fd32a622fcec2a8f0db9f1681edbd3))
* **deps:** Bump github/codeql-action from 4.37.6 to 4.37.7 ([#750](https://github.com/thefalconry/talon/issues/750)) ([9d3c9d6](https://github.com/thefalconry/talon/commit/9d3c9d6b90dae419d73331c2f8f63f5907555536))
* **deps:** Bump the production-dependencies group with 2 updates ([#745](https://github.com/thefalconry/talon/issues/745)) ([77005a9](https://github.com/thefalconry/talon/commit/77005a9b40a83aebbe79f01858301efd3e46255a))
* **deps:** Bump the production-dependencies group with 7 updates ([#742](https://github.com/thefalconry/talon/issues/742)) ([5086099](https://github.com/thefalconry/talon/commit/5086099534d13b0344eb5338e0ceec3d40352b94))

## [3.19.1](https://github.com/thefalconry/talon/compare/v3.19.0...v3.19.1) (2026-08-10)


### Bug Fixes

* **test:** give the chat-retention test room on Windows ([cdb230f](https://github.com/thefalconry/talon/commit/cdb230f6a4fea0934a93b8b8f981c4c5d8eaa3bc))
* **test:** give the chat-retention test room on Windows ([f08c9c3](https://github.com/thefalconry/talon/commit/f08c9c3d34c9d22c506580cfc2f630e848aec904))


### Miscellaneous Chores

* **deps:** Bump github/codeql-action from 4.37.4 to 4.37.6 ([#737](https://github.com/thefalconry/talon/issues/737)) ([55b434b](https://github.com/thefalconry/talon/commit/55b434b20bf830c3fc739e4cdc616a9625d11aeb))
* **deps:** Bump the production-dependencies group with 6 updates ([#738](https://github.com/thefalconry/talon/issues/738)) ([9697d7b](https://github.com/thefalconry/talon/commit/9697d7bdfb4c6485fe324933d0778d6a679d1032))

## [3.19.0](https://github.com/thefalconry/talon/compare/v3.18.0...v3.19.0) (2026-08-07)


### Features

* **codex:** show banked usage-limit resets on /usage ([ed5b32b](https://github.com/thefalconry/talon/commit/ed5b32b80809617c54b27efa0776858209e1f771))
* **codex:** show banked usage-limit resets on the usage command ([b68af66](https://github.com/thefalconry/talon/commit/b68af66fb8077430a8f7eba281198499931feb35))


### Miscellaneous Chores

* **deps:** Bump the production-dependencies group with 4 updates ([#731](https://github.com/thefalconry/talon/issues/731)) ([dfc7dff](https://github.com/thefalconry/talon/commit/dfc7dff48c3f2e08d34f49a414981141a72d949d))
* **deps:** Bump tsx in the production-dependencies group ([#733](https://github.com/thefalconry/talon/issues/733)) ([8483ea2](https://github.com/thefalconry/talon/commit/8483ea2b15d1cb6722df2774ae04762e425a0a03))

## [3.18.0](https://github.com/thefalconry/talon/compare/v3.17.0...v3.18.0) (2026-08-04)


### Features

* **discord:** add the four commands only Telegram had ([f1cc0ee](https://github.com/thefalconry/talon/commit/f1cc0ee9b34bbe1e8a8af9294977d028dbb1a687))
* **models:** paginate the picker, and let Discord switch backends ([3eab3fc](https://github.com/thefalconry/talon/commit/3eab3fc80b730fd84662dfdd47ef57c8bdaa3f79))

## [3.17.0](https://github.com/thefalconry/talon/compare/v3.16.1...v3.17.0) (2026-08-04)


### Features

* add /usage — plan limits across every backend ([#718](https://github.com/thefalconry/talon/issues/718)) ([f9e0af5](https://github.com/thefalconry/talon/commit/f9e0af563771894f9df20377f62e0ced7e737aef))
* **background:** warn the admin chat before plan limits run out ([#710](https://github.com/thefalconry/talon/issues/710)) ([b53bec9](https://github.com/thefalconry/talon/commit/b53bec9385a377da0579c8d6e4328531d525d0b9))
* **doctor:** check every exposed backend, and group the idle ones ([#715](https://github.com/thefalconry/talon/issues/715)) ([710bbb5](https://github.com/thefalconry/talon/commit/710bbb5abd2ca1a89af5fa2e6dcbf094f7fbc3a5))


### Bug Fixes

* **discord:** feed reactions on the bot's messages to the soul ([#714](https://github.com/thefalconry/talon/issues/714)) ([c99981b](https://github.com/thefalconry/talon/commit/c99981be87e5dd085e51a0d8821bc7b030600f96))


### Miscellaneous Chores

* **deps-dev:** Bump knip in the dev-dependencies group ([#720](https://github.com/thefalconry/talon/issues/720)) ([0834ebc](https://github.com/thefalconry/talon/commit/0834ebcdf0dd044ab38682992bc2d4c426104817))
* **deps:** Bump docker/login-action from 4.5.2 to 4.6.0 ([#721](https://github.com/thefalconry/talon/issues/721)) ([992e6f9](https://github.com/thefalconry/talon/commit/992e6f9cdcc850dda5057d91591ed93e60652131))
* **deps:** Bump fast-uri from 3.1.4 to 3.1.5 ([#726](https://github.com/thefalconry/talon/issues/726)) ([07d93e4](https://github.com/thefalconry/talon/commit/07d93e4583999a26356bd353c052217cced31d29))
* **deps:** Bump github/codeql-action from 4.37.3 to 4.37.4 ([#722](https://github.com/thefalconry/talon/issues/722)) ([b770a8b](https://github.com/thefalconry/talon/commit/b770a8b86802e4220bf6f7c5ede0b84a6e68858e))
* **deps:** Bump ip-address from 10.2.0 to 10.4.0 ([#723](https://github.com/thefalconry/talon/issues/723)) ([f6fe8af](https://github.com/thefalconry/talon/commit/f6fe8af052fd3cb1034baa0f86c391480218e711))
* **deps:** Bump undici ([#724](https://github.com/thefalconry/talon/issues/724)) ([f34ae0f](https://github.com/thefalconry/talon/commit/f34ae0f9b3bb7324fd4eb17eaa85a636980fd69d))

## [3.16.1](https://github.com/thefalconry/talon/compare/v3.16.0...v3.16.1) (2026-08-03)


### Miscellaneous Chores

* **deps:** Bump docker/login-action from 3 to 4.5.2 ([#700](https://github.com/thefalconry/talon/issues/700)) ([8d7ea6f](https://github.com/thefalconry/talon/commit/8d7ea6fc1ebb4da256760af461cf62acf9196245))
* **deps:** Bump github/codeql-action from 3 to 4.37.3 ([#699](https://github.com/thefalconry/talon/issues/699)) ([f67902c](https://github.com/thefalconry/talon/commit/f67902cb8f48c33ccac50070239e297d1abb954c))

## [3.16.0](https://github.com/thefalconry/talon/compare/v3.15.3...v3.16.0) (2026-08-02)


### Features

* **status:** show plan rate limits and session cost ([#709](https://github.com/thefalconry/talon/issues/709)) ([d3e2472](https://github.com/thefalconry/talon/commit/d3e24729ef25b1d1993b476c001eb197047d06c7))

## [3.15.3](https://github.com/thefalconry/talon/compare/v3.15.2...v3.15.3) (2026-08-02)


### Bug Fixes

* **remote:** stop OpenCode and Kilo re-sending progress text at end of turn ([#711](https://github.com/thefalconry/talon/issues/711)) ([d3be553](https://github.com/thefalconry/talon/commit/d3be5531f87c2fe730c8838701819050c9851303))

## [3.15.2](https://github.com/thefalconry/talon/compare/v3.15.1...v3.15.2) (2026-08-02)


### Bug Fixes

* **telegram:** escape the remaining backend-supplied HTML sinks ([#707](https://github.com/thefalconry/talon/issues/707)) ([4ac566f](https://github.com/thefalconry/talon/commit/4ac566f6d45fb8cdf079a1aba6c6e345d941ae03))

## [3.15.1](https://github.com/thefalconry/talon/compare/v3.15.0...v3.15.1) (2026-08-02)


### Bug Fixes

* **remote:** harden OpenCode and Kilo runtime parity ([#705](https://github.com/thefalconry/talon/issues/705)) ([5a67c0d](https://github.com/thefalconry/talon/commit/5a67c0d21771fa31f49b1b4fffb76336ca2b3400))
* **runtime:** harden model menu and restart handoff ([#704](https://github.com/thefalconry/talon/issues/704)) ([87554b4](https://github.com/thefalconry/talon/commit/87554b4b5c9dd0cfc9192b7d72eb73ee6112ec63))

## [3.15.0](https://github.com/thefalconry/talon/compare/v3.14.0...v3.15.0) (2026-07-31)


### Features

* **terminal:** /context command — context window usage, broken down ([#701](https://github.com/thefalconry/talon/issues/701)) ([8a2cf77](https://github.com/thefalconry/talon/commit/8a2cf77226fdbf23960161ac585eb5dc89a0b4d0))

## [3.14.0](https://github.com/thefalconry/talon/compare/v3.13.0...v3.14.0) (2026-07-30)


### Features

* **companion:** screen-reader semantics for tap targets ([#664](https://github.com/thefalconry/talon/issues/664)) ([5d98164](https://github.com/thefalconry/talon/commit/5d98164389520a059c02b10c0b0204ba46c3214c))
* **companion:** WCAG AA contrast + button roles on text-bearing tap targets ([#668](https://github.com/thefalconry/talon/issues/668)) ([ee9f724](https://github.com/thefalconry/talon/commit/ee9f72475ef2ec9cdf3b152ac9f2021f403ac727))
* **prompts:** identity.md as voice and stances, not adjectives ([#691](https://github.com/thefalconry/talon/issues/691)) ([39c4fae](https://github.com/thefalconry/talon/commit/39c4faed3feafb8a4079a4e4b1eb7478baac5ec7))


### Bug Fixes

* **prompts:** split live state out of durable memory ([#694](https://github.com/thefalconry/talon/issues/694)) ([71d8663](https://github.com/thefalconry/talon/commit/71d8663886f811fbf25bb2a6327c04b7d85600dd))


### Miscellaneous Chores

* **deps:** ignore openai major bumps until agents SDK supports v7 ([#677](https://github.com/thefalconry/talon/issues/677)) ([d5642ee](https://github.com/thefalconry/talon/commit/d5642ee4e40260474473af277e53cc14021c2555))


### Continuous Integration

* **secrets:** pin the secret scan to the checked-out ref's own history ([#695](https://github.com/thefalconry/talon/issues/695)) ([eac88a9](https://github.com/thefalconry/talon/commit/eac88a91109b9e4fbce8f8ddbf1b2260bd8c90ab))

## [3.13.0](https://github.com/thefalconry/talon/compare/v3.12.5...v3.13.0) (2026-07-30)


### Features

* **metrics:** per-turn prompt-cache telemetry ([#687](https://github.com/thefalconry/talon/issues/687)) ([f5e0d53](https://github.com/thefalconry/talon/commit/f5e0d535536fe5dc76915b54e1ab9ce9d584deda))


### Bug Fixes

* **prompt:** rank memory sections instead of head-slicing ([#686](https://github.com/thefalconry/talon/issues/686)) ([4fe4020](https://github.com/thefalconry/talon/commit/4fe4020ec636388ea5ac714c823abea48858e71a))

## [3.12.5](https://github.com/thefalconry/talon/compare/v3.12.4...v3.12.5) (2026-07-30)


### Continuous Integration

* **secrets:** allowlist the secret-scan guard's own fake fixtures ([#688](https://github.com/thefalconry/talon/issues/688)) ([0023cce](https://github.com/thefalconry/talon/commit/0023cce3868dc52bf66f4921525dd0054ec0415c))

## [3.12.4](https://github.com/thefalconry/talon/compare/v3.12.3...v3.12.4) (2026-07-30)


### Miscellaneous Chores

* **deps:** Bump the production-dependencies group with 3 updates ([#682](https://github.com/thefalconry/talon/issues/682)) ([6ed6753](https://github.com/thefalconry/talon/commit/6ed6753e0ab39af674f9c1a5679b1b4c91b9a8e1))


### Continuous Integration

* **fuse:** probe real mount capability; drop the disproven AppArmor step ([#685](https://github.com/thefalconry/talon/issues/685)) ([34939a9](https://github.com/thefalconry/talon/commit/34939a9f65f852ef805ab208b8dbb229088e999f))

## [3.12.3](https://github.com/thefalconry/talon/compare/v3.12.2...v3.12.3) (2026-07-29)


### Bug Fixes

* **telegram:** stop emphasis passes from eating link targets ([#680](https://github.com/thefalconry/talon/issues/680)) ([5e0f992](https://github.com/thefalconry/talon/commit/5e0f9924c6f27030f49edf5317ecd8eae8189e70))

## [3.12.2](https://github.com/thefalconry/talon/compare/v3.12.1...v3.12.2) (2026-07-29)


### Bug Fixes

* **telegram:** use native Rich Markdown delivery ([#678](https://github.com/thefalconry/talon/issues/678)) ([9aa6eda](https://github.com/thefalconry/talon/commit/9aa6edab72a57261f8b1e4fb1fc7108a9063acb1))


### Miscellaneous Chores

* **deps:** Bump the production-dependencies group with 2 updates ([#675](https://github.com/thefalconry/talon/issues/675)) ([e852ff2](https://github.com/thefalconry/talon/commit/e852ff21ff8fd460a2bf31bbf3a8259273518596))

## [3.12.1](https://github.com/thefalconry/talon/compare/v3.12.0...v3.12.1) (2026-07-28)


### Bug Fixes

* **gateway:** let mesh actions run without a chat context ([#669](https://github.com/thefalconry/talon/issues/669)) ([6078a66](https://github.com/thefalconry/talon/commit/6078a66888d3e74c848f76b12bd371bf550328a5))


### Miscellaneous Chores

* **deps-dev:** Bump the dev-dependencies group with 2 updates ([#672](https://github.com/thefalconry/talon/issues/672)) ([23d76d6](https://github.com/thefalconry/talon/commit/23d76d6ee05f5c4dfa591a0d073214544c484b7f))
* **deps:** Bump the production-dependencies group with 4 updates ([#673](https://github.com/thefalconry/talon/issues/673)) ([e8f5635](https://github.com/thefalconry/talon/commit/e8f5635b8f6e63d5212f3e0999e82463a9aa5b01))

## [3.12.0](https://github.com/thefalconry/talon/compare/v3.11.1...v3.12.0) (2026-07-27)


### Features

* **prompt:** carry the sender's [@handle](https://github.com/handle) into group prompts ([#666](https://github.com/thefalconry/talon/issues/666)) ([3eaa95f](https://github.com/thefalconry/talon/commit/3eaa95fcbbcdf6b48388773cf414a93a280a1488))

## [3.11.1](https://github.com/thefalconry/talon/compare/v3.11.0...v3.11.1) (2026-07-26)


### Bug Fixes

* **companion:** anchor screenshot-gallery fixtures to noon, not the wall clock ([#665](https://github.com/thefalconry/talon/issues/665)) ([419f255](https://github.com/thefalconry/talon/commit/419f255cebc06c62c8634fc2acec662306937fab))

## [3.11.0](https://github.com/thefalconry/talon/compare/v3.10.0...v3.11.0) (2026-07-25)


### Features

* **companion:** notify on assistant replies in the background ([#661](https://github.com/thefalconry/talon/issues/661)) ([d00ccb6](https://github.com/thefalconry/talon/commit/d00ccb6c4c8b63421b5fe9f5722bc28665b143c4))

## [3.10.0](https://github.com/thefalconry/talon/compare/v3.9.1...v3.10.0) (2026-07-25)


### Features

* **companion:** phone-first UI — touch density, full-bleed home, Material You ([#660](https://github.com/thefalconry/talon/issues/660)) ([30fd760](https://github.com/thefalconry/talon/commit/30fd76059c66a82a1578e25a76ebe638bd126222))

## [3.9.1](https://github.com/thefalconry/talon/compare/v3.9.0...v3.9.1) (2026-07-25)


### Bug Fixes

* **node:** stop cmd.Wait() eating exec output, and time-box both drains ([#658](https://github.com/thefalconry/talon/issues/658)) ([79fe838](https://github.com/thefalconry/talon/commit/79fe8389a4ac084eda663dca8493cb6dc2dcda65))

## [3.9.0](https://github.com/thefalconry/talon/compare/v3.8.2...v3.9.0) (2026-07-25)


### Features

* **companion:** natural-sounding voice mode and a living orb ([#635](https://github.com/thefalconry/talon/issues/635)) ([21d674a](https://github.com/thefalconry/talon/commit/21d674a003436678484dfaf14a408a4c681d5cb4))
* **companion:** settings chapters, command palette, actionable context ([#653](https://github.com/thefalconry/talon/issues/653)) ([b21a631](https://github.com/thefalconry/talon/commit/b21a631064cdf1a6a95bc859fa8c0b646ead2e6f))
* **terminal:** add prompt history and richer status ([#601](https://github.com/thefalconry/talon/issues/601)) ([b3cb5cc](https://github.com/thefalconry/talon/commit/b3cb5ccba74de48e83edc627eeff84ae4c354bec))


### Bug Fixes

* **bridge:** refuse browser-driven and DNS-rebound requests ([#648](https://github.com/thefalconry/talon/issues/648)) ([552c13b](https://github.com/thefalconry/talon/commit/552c13b42bea87e9382de59239388c273d5771b3))
* **discord:** keep API error codes readable after withRetry wraps them ([#654](https://github.com/thefalconry/talon/issues/654)) ([2ff7237](https://github.com/thefalconry/talon/commit/2ff7237178bcd1b4610e7b330cbdf1ccd4354538))
* **discord:** stop one bad button or a long reply losing the whole message ([#651](https://github.com/thefalconry/talon/issues/651)) ([ade9b5a](https://github.com/thefalconry/talon/commit/ade9b5acd82e1960594b7dfcbd711a951bcef2d2))
* **mesh:** address device commands, attribute results, bind transfer tokens, bound the registry ([#655](https://github.com/thefalconry/talon/issues/655)) ([609d9b6](https://github.com/thefalconry/talon/commit/609d9b69749898effd7c4ff833968ae3d133b440))
* **telegram:** enforce the 64-BYTE callback_data cap on inline buttons ([#644](https://github.com/thefalconry/talon/issues/644)) ([3881b67](https://github.com/thefalconry/talon/commit/3881b67529a7a74e1e317c83d9482311e230b23a))
* **telegram:** never emit crossed HTML tags from markdown conversion ([#643](https://github.com/thefalconry/talon/issues/643)) ([970079c](https://github.com/thefalconry/talon/commit/970079cda0ca14094480db04293f1cb511b978a6))
* **tests:** reap leaked mkdtemp scratch dirs after each run ([#652](https://github.com/thefalconry/talon/issues/652)) ([82782ca](https://github.com/thefalconry/talon/commit/82782ca3774a8d7d6931b72b9912c9300f89ef10))


### Code Refactoring

* **backends:** trim dead kilo/opencode barrel surface ([#647](https://github.com/thefalconry/talon/issues/647)) ([7d71c80](https://github.com/thefalconry/talon/commit/7d71c80f7b65d2dee458fb2a0baf71d3dc002f34))
* delete superseded/dead modules, make knip output actionable ([#646](https://github.com/thefalconry/talon/issues/646)) ([d4568bc](https://github.com/thefalconry/talon/commit/d4568bc769da5cc0f554c3a846bbc1d986741079))
* **layering:** fix two depcruise violations, correct three rule contracts ([#650](https://github.com/thefalconry/talon/issues/650)) ([1db5948](https://github.com/thefalconry/talon/commit/1db59481ba6c01b84844a3270f803c3ff161fb92))
* trim unused re-exports from core and cli barrels ([#649](https://github.com/thefalconry/talon/issues/649)) ([8f99264](https://github.com/thefalconry/talon/commit/8f9926428cd58ea04271b3734d6dfda929b47bcd))

## [3.8.2](https://github.com/thefalconry/talon/compare/v3.8.1...v3.8.2) (2026-07-25)


### Code Refactoring

* **companion:** drop per-chat pulse ([#645](https://github.com/thefalconry/talon/issues/645)) ([3e9a339](https://github.com/thefalconry/talon/commit/3e9a339eff87c84f8a9025745c9aff85bd2cc1db))

## [3.8.1](https://github.com/thefalconry/talon/compare/v3.8.0...v3.8.1) (2026-07-25)


### Bug Fixes

* **errors:** classify transient transport failures as retryable ([#641](https://github.com/thefalconry/talon/issues/641)) ([e3c6209](https://github.com/thefalconry/talon/commit/e3c620987d266334a5bdb013d61224aa17756147))
* **telegram:** single-message /metrics panel with grain buttons, de-slop /mesh ([#640](https://github.com/thefalconry/talon/issues/640)) ([d389b0a](https://github.com/thefalconry/talon/commit/d389b0af8ca12779a4665a947e8e15024af70b30))


### Code Refactoring

* **memory:** remove Phase B pre-retrieval, keep memory.md + tool search ([#639](https://github.com/thefalconry/talon/issues/639)) ([b0f253e](https://github.com/thefalconry/talon/commit/b0f253e5b26b5aa8a99443faa6923ebbfaa3fc46))

## [3.8.0](https://github.com/thefalconry/talon/compare/v3.7.0...v3.8.0) (2026-07-25)


### Features

* **background:** configurable reasoning effort for heartbeat and dream ([#636](https://github.com/thefalconry/talon/issues/636)) ([9f7899f](https://github.com/thefalconry/talon/commit/9f7899fed8841d90c0672817046ca2432e242581))


### Miscellaneous Chores

* **deps:** Bump the production-dependencies group with 5 updates ([#634](https://github.com/thefalconry/talon/issues/634)) ([4e184c9](https://github.com/thefalconry/talon/commit/4e184c9a013aa376c12567669065f5737262b10c))

## [3.7.0](https://github.com/thefalconry/talon/compare/v3.6.3...v3.7.0) (2026-07-24)


### Features

* **companion:** full-screen voice mode + Android assistant role ([#630](https://github.com/thefalconry/talon/issues/630)) ([6e44b61](https://github.com/thefalconry/talon/commit/6e44b619f66453ed984f70e4ed5b70f0c24d8e3b))

## [3.6.3](https://github.com/thefalconry/talon/compare/v3.6.2...v3.6.3) (2026-07-24)


### Bug Fixes

* **scheduler:** cron dead since Jun 29 — start before blocking frontend await, drift-proof dueness, trigger GC, playwright pin ([#617](https://github.com/thefalconry/talon/issues/617)) ([2639250](https://github.com/thefalconry/talon/commit/263925095103237f43f0b1945e6b0210fd620089))


### Miscellaneous Chores

* **deps:** Bump @anthropic-ai/claude-agent-sdk ([#629](https://github.com/thefalconry/talon/issues/629)) ([072ad74](https://github.com/thefalconry/talon/commit/072ad74cd261fcfdcd8d51c822de43a78c4e54e5))
* **deps:** Bump actions/upload-artifact from 6 to 7 ([#618](https://github.com/thefalconry/talon/issues/618)) ([e720b4b](https://github.com/thefalconry/talon/commit/e720b4b6f792e3349087e1a11eb7867c45be51cd))

## [3.6.2](https://github.com/thefalconry/talon/compare/v3.6.1...v3.6.2) (2026-07-22)


### Documentation

* add hero banner to README ([#627](https://github.com/thefalconry/talon/issues/627)) ([747a057](https://github.com/thefalconry/talon/commit/747a0578894138b18271d9b8e3bf58c41f151882))

## [3.6.1](https://github.com/thefalconry/talon/compare/v3.6.0...v3.6.1) (2026-07-22)


### Documentation

* add Sponsor badge and Support section to README ([#625](https://github.com/thefalconry/talon/issues/625)) ([19640f1](https://github.com/thefalconry/talon/commit/19640f14cdb888dbe242c1e4c4785d29fe90cd4e))

## [3.6.0](https://github.com/thefalconry/talon/compare/v3.5.0...v3.6.0) (2026-07-22)


### Features

* **goals:** remove the per-chat open-goal cap ([#622](https://github.com/thefalconry/talon/issues/622)) ([7f292c2](https://github.com/thefalconry/talon/commit/7f292c2595fb65ec094464d6145efbb3f3539fa0))


### Miscellaneous Chores

* add GitHub Sponsors funding config ([#623](https://github.com/thefalconry/talon/issues/623)) ([6910d82](https://github.com/thefalconry/talon/commit/6910d825c595e05529a7f82199f086faf5ee520b))
* **deps-dev:** Bump the dev-dependencies group with 2 updates ([#620](https://github.com/thefalconry/talon/issues/620)) ([82f426b](https://github.com/thefalconry/talon/commit/82f426bd52a72186ab11ac86e1724603b3d1df82))
* **deps:** Bump actions/setup-go from 6 to 7 ([#619](https://github.com/thefalconry/talon/issues/619)) ([f66aa32](https://github.com/thefalconry/talon/commit/f66aa32448fd56b66de051bc3536da0ef789d39f))
* **deps:** Bump the production-dependencies group with 3 updates ([#621](https://github.com/thefalconry/talon/issues/621)) ([4ad72ca](https://github.com/thefalconry/talon/commit/4ad72caa2340d3844056d24cf603bdfd311d81e2))

## [3.5.0](https://github.com/thefalconry/talon/compare/v3.4.1...v3.5.0) (2026-07-22)


### Features

* **frontend:** frontend SDK — capability contract + self-registering frontend registry ([#615](https://github.com/thefalconry/talon/issues/615)) ([362d1be](https://github.com/thefalconry/talon/commit/362d1be02553aec3a9c6a62809d4042c4b45755c))


### Tests

* **protocol:** tri-implementation bridge protocol conformance suite ([#614](https://github.com/thefalconry/talon/issues/614)) ([53c1c87](https://github.com/thefalconry/talon/commit/53c1c87bc5e38e9071bf0212b86c671d86f63e62))

## [3.4.1](https://github.com/thefalconry/talon/compare/v3.4.0...v3.4.1) (2026-07-22)


### Bug Fixes

* **ci:** stop release-please ignoring its config file (release-type input override) ([#612](https://github.com/thefalconry/talon/issues/612)) ([9b7240c](https://github.com/thefalconry/talon/commit/9b7240c8b69351517452e9d2776a9a314385f614))

## [3.4.0](https://github.com/thefalconry/talon/compare/v3.3.0...v3.4.0) (2026-07-22)


### Features

* **mesh:** node provisioning — binary resolver, bridge-served installers, arch-aware update_node ([#610](https://github.com/thefalconry/talon/issues/610)) ([abadad9](https://github.com/thefalconry/talon/commit/abadad90995fefe8cb3793162f16c000f1969f99))

## [3.3.0](https://github.com/thefalconry/talon/compare/v3.2.0...v3.3.0) (2026-07-22)


### Features

* **telegram:** /mesh command to ping and list mesh devices ([#606](https://github.com/thefalconry/talon/issues/606)) ([bbc709d](https://github.com/thefalconry/talon/commit/bbc709d89e47d2342356a504e2ee702c2478e7d3))

## [3.2.0](https://github.com/thefalconry/talon/compare/v3.1.1...v3.2.0) (2026-07-21)


### Features

* **node:** talon-node — headless mesh device for servers (Linux/macOS/Windows) ([#602](https://github.com/thefalconry/talon/issues/602)) ([09d863b](https://github.com/thefalconry/talon/commit/09d863b4389796d67816e0801e61264aa1b6e157))

## [3.1.1](https://github.com/thefalconry/talon/compare/v3.1.0...v3.1.1) (2026-07-21)


### Bug Fixes

* **security:** closed-by-default bridge auth + owner-only at-rest permissions ([#596](https://github.com/thefalconry/talon/issues/596)) ([60c983d](https://github.com/thefalconry/talon/commit/60c983debca2e2d0883a4560e0230b6a76d5f990))

## [3.1.0](https://github.com/thefalconry/talon/compare/v3.0.5...v3.1.0) (2026-07-21)


### Features

* **companion:** desktop keyboard shortcuts help dialog ([#592](https://github.com/thefalconry/talon/issues/592)) ([613c94e](https://github.com/thefalconry/talon/commit/613c94e74f45562c596192a9a42d489e28a4db5d))

## [3.0.5](https://github.com/thefalconry/talon/compare/v3.0.4...v3.0.5) (2026-07-18)


### Bug Fixes

* **telegram:** literal placeholder restore + single-escape link hrefs ([#590](https://github.com/thefalconry/talon/issues/590)) ([80b5bbb](https://github.com/thefalconry/talon/commit/80b5bbb0887c00466f6e3574a8df0d9e45f48336))

## [3.0.4](https://github.com/thefalconry/talon/compare/v3.0.3...v3.0.4) (2026-07-18)


### Bug Fixes

* **native:** edit binary guard, edit line report, find fallback -type f ([#588](https://github.com/thefalconry/talon/issues/588)) ([5252ff5](https://github.com/thefalconry/talon/commit/5252ff59399a319d26341d2b3d6d8a526e5397a0))

## [3.0.3](https://github.com/thefalconry/talon/compare/v3.0.2...v3.0.3) (2026-07-18)


### Bug Fixes

* **companion:** clean up code block rendering ([#585](https://github.com/thefalconry/talon/issues/585)) ([70e83fd](https://github.com/thefalconry/talon/commit/70e83fd8ac2cb46ea46d10df1195165c9793c994))
* **native:** make edit literal, guard reads, validate cwd, sort glob ([#584](https://github.com/thefalconry/talon/issues/584)) ([6469fe0](https://github.com/thefalconry/talon/commit/6469fe050db8262aced02d460f66cb1a624ece2a))

## [3.0.2](https://github.com/thefalconry/talon/compare/v3.0.1...v3.0.2) (2026-07-18)


### Bug Fixes

* **repo:** untrack the node_modules symlink that shipped in [#578](https://github.com/thefalconry/talon/issues/578) ([#582](https://github.com/thefalconry/talon/issues/582)) ([c150c19](https://github.com/thefalconry/talon/commit/c150c199040a0758cad067299c9f61fae0575f8d))

## [3.0.1](https://github.com/thefalconry/talon/compare/v3.0.0...v3.0.1) (2026-07-18)


### Bug Fixes

* **cli:** native frontend no longer fail-closes setup & doctor; doctor probes the ns mountpoint ([#580](https://github.com/thefalconry/talon/issues/580)) ([7c39090](https://github.com/thefalconry/talon/commit/7c39090af0d6b3492bda2e87e608ee882822b774))

## [3.0.0](https://github.com/thefalconry/talon/compare/v2.0.2...v3.0.0) (2026-07-18)


### ⚠ BREAKING CHANGES

* **vfs:** remove the talon:// address scheme; reach the namespace by real path ([#578](https://github.com/thefalconry/talon/issues/578))

### Code Refactoring

* **vfs:** remove the talon:// address scheme; reach the namespace by real path ([#578](https://github.com/thefalconry/talon/issues/578)) ([e0c477a](https://github.com/thefalconry/talon/commit/e0c477ab52bb7e40870a662140af9ce587333c1e))

## [2.0.2](https://github.com/thefalconry/talon/compare/v2.0.1...v2.0.2) (2026-07-17)


### Bug Fixes

* **codex:** per-turn token accounting — rollout delta over cumulative SDK usage ([#575](https://github.com/thefalconry/talon/issues/575)) ([b707d5d](https://github.com/thefalconry/talon/commit/b707d5d8f37e9748c87a375a2320b5c9e7958dfd))

## [2.0.1](https://github.com/thefalconry/talon/compare/v2.0.0...v2.0.1) (2026-07-17)


### Bug Fixes

* **vfs:** rebuilding native addons no longer SIGBUS-kills the daemon; FUSE self-heals ([#573](https://github.com/thefalconry/talon/issues/573)) ([4a57b90](https://github.com/thefalconry/talon/commit/4a57b90cec60d769bd205b492e121e77ff48f02d))

## [2.0.0](https://github.com/thefalconry/talon/compare/v1.53.0...v2.0.0) (2026-07-17)


### ⚠ BREAKING CHANGES

* **vfs:** vfs_list/vfs_read/vfs_write tools, GET /vfs/* gateway routes, and the talon ls/cat CLI commands are gone — the namespace is served through ~/.talon/ns and the native tools' talon:// support.

### Features

* **vfs:** unified talon:// namespace — strict grammar, real mountpoint, FUSE live views ([#571](https://github.com/thefalconry/talon/issues/571)) ([a8f0f7c](https://github.com/thefalconry/talon/commit/a8f0f7cbcb84ed2d25b07d4ddc6f9caa7ee34fb6))

## [1.53.0](https://github.com/thefalconry/talon/compare/v1.52.0...v1.53.0) (2026-07-16)


### Features

* **companion:** light-indigo redesign — settings screen to concept ([#550](https://github.com/thefalconry/talon/issues/550)) ([12600e1](https://github.com/thefalconry/talon/commit/12600e1a508fa2fe6b6e865cd0ce49936a712af0))

## [1.52.0](https://github.com/thefalconry/talon/compare/v1.51.0...v1.52.0) (2026-07-16)


### Features

* **bridge:** plugin & skill endpoints — list and toggle over the client bridge ([#563](https://github.com/thefalconry/talon/issues/563)) ([34769df](https://github.com/thefalconry/talon/commit/34769dffd70e48a49eb77a5af228453bf98b44da))
* **core:** one-shot runs report token usage — talon ps accounts heartbeat/dream/cron burn ([#566](https://github.com/thefalconry/talon/issues/566)) ([b8857e2](https://github.com/thefalconry/talon/commit/b8857e2141c909760a8c007d3b9b6ab5c80d31db))

## [1.51.0](https://github.com/thefalconry/talon/compare/v1.50.0...v1.51.0) (2026-07-16)


### Features

* **cli:** plugin & skill managers — install/enable/disable from npm, git, and local sources ([#559](https://github.com/thefalconry/talon/issues/559)) ([bee5bc7](https://github.com/thefalconry/talon/commit/bee5bc72edc0726b7ec652d88f6546b3c9236ff1))
* **companion:** Plugins & Skills settings sub-menus ([#565](https://github.com/thefalconry/talon/issues/565)) ([d7adf48](https://github.com/thefalconry/talon/commit/d7adf48af3c37befcec00623b0b3eb0d84197d3a))

## [1.50.0](https://github.com/thefalconry/talon/compare/v1.49.0...v1.50.0) (2026-07-16)


### Features

* **core:** event journal — durable bus tail in talon.db ([#562](https://github.com/thefalconry/talon/issues/562)) ([d505af6](https://github.com/thefalconry/talon/commit/d505af6e9c5ebc26c98a7cccc9edb3e0976ad2d0))
* **core:** killable turns — talon kill interrupts a running chat turn on every backend ([#561](https://github.com/thefalconry/talon/issues/561)) ([8771566](https://github.com/thefalconry/talon/commit/8771566bf03b9b7f56e0561eba2e4ac2878e4c35))
* **core:** VFS — unified talon:// namespace with /proc-style live mounts ([#560](https://github.com/thefalconry/talon/issues/560)) ([b0c72a6](https://github.com/thefalconry/talon/commit/b0c72a69509a6c538cd98a977c23bd38b9b985cc))
* **native:** TLS for the client bridge — pinned self-signed certificate, encrypted companion transport ([#554](https://github.com/thefalconry/talon/issues/554)) ([af788b7](https://github.com/thefalconry/talon/commit/af788b778dd8431f3f520bbefc5b08398d936cf7))

## [1.49.0](https://github.com/thefalconry/talon/compare/v1.48.0...v1.49.0) (2026-07-16)


### Features

* **core:** event bus — typed pub-sub spine with task/turn events and talon events tail ([#557](https://github.com/thefalconry/talon/issues/557)) ([ab10f83](https://github.com/thefalconry/talon/commit/ab10f8386cc1c1d4a3736c1babed569f369425d0))

## [1.48.0](https://github.com/thefalconry/talon/compare/v1.47.2...v1.48.0) (2026-07-16)


### Features

* **core:** task table — live registry of agent work with talon ps / talon kill ([#553](https://github.com/thefalconry/talon/issues/553)) ([5368874](https://github.com/thefalconry/talon/commit/5368874549a7aae96e9fb0161bc7429ee6833aee))

## [1.47.2](https://github.com/thefalconry/talon/compare/v1.47.1...v1.47.2) (2026-07-15)


### Bug Fixes

* **native:** read image files as viewable image blocks, not mojibake ([#548](https://github.com/thefalconry/talon/issues/548)) ([0844fa0](https://github.com/thefalconry/talon/commit/0844fa009d0b0bfcad4bd08c286034c6a1b5f4e8))

## [1.47.1](https://github.com/thefalconry/talon/compare/v1.47.0...v1.47.1) (2026-07-15)


### Bug Fixes

* bound fetch_url response buffering ([#541](https://github.com/thefalconry/talon/issues/541)) ([f99a1c3](https://github.com/thefalconry/talon/commit/f99a1c35578b0bd421d1b8e9cf789f5b465dae36))

## [1.47.0](https://github.com/thefalconry/talon/compare/v1.46.1...v1.47.0) (2026-07-12)


### Features

* **companion:** UI overhaul — bundled type, gradient identity, depth & motion polish ([#539](https://github.com/thefalconry/talon/issues/539)) ([eab644a](https://github.com/thefalconry/talon/commit/eab644a2c413bdfa69f2fadc9d73e531afaef8e8))

## [1.46.1](https://github.com/thefalconry/talon/compare/v1.46.0...v1.46.1) (2026-07-12)


### Bug Fixes

* **codex:** live tool lifecycle — real durations instead of 0ms ([#536](https://github.com/thefalconry/talon/issues/536)) ([c9e0398](https://github.com/thefalconry/talon/commit/c9e03985ee0ccd3a52e29a35937d92af4f07bcc4))

## [1.46.0](https://github.com/thefalconry/talon/compare/v1.45.0...v1.46.0) (2026-07-12)


### Features

* **companion:** custom accent colors, text size, and haptics in Settings ([#535](https://github.com/thefalconry/talon/issues/535)) ([81cbd2e](https://github.com/thefalconry/talon/commit/81cbd2e38d6c12804965e3c7d2294287822605cf))

## [1.45.0](https://github.com/thefalconry/talon/compare/v1.44.0...v1.45.0) (2026-07-11)


### Features

* **companion:** desktop start-at-login toggle ([#533](https://github.com/thefalconry/talon/issues/533)) ([142d444](https://github.com/thefalconry/talon/commit/142d44478417b44f8a26bbe2db19d82e8c508d46))

## [1.44.0](https://github.com/thefalconry/talon/compare/v1.43.0...v1.44.0) (2026-07-11)


### Features

* **companion:** Windows system tray residency — close hides, mesh stays alive ([#531](https://github.com/thefalconry/talon/issues/531)) ([75fcf51](https://github.com/thefalconry/talon/commit/75fcf512ea08db6ad636cf7a346fdd1d7b3951f2))

## [1.43.0](https://github.com/thefalconry/talon/compare/v1.42.2...v1.43.0) (2026-07-11)


### Features

* **companion:** macOS menu bar residency — mesh survives window close ([#528](https://github.com/thefalconry/talon/issues/528)) ([2f5c6c0](https://github.com/thefalconry/talon/commit/2f5c6c02f1918e7f97e38ea8692f10476fa62ae6))


### Bug Fixes

* **watchdog:** idle is not a fault — warn only when work is actually stuck ([#529](https://github.com/thefalconry/talon/issues/529)) ([eabdc9e](https://github.com/thefalconry/talon/commit/eabdc9e45dd67f8e83049979d4f69bcf3ecc6868))

## [1.42.2](https://github.com/thefalconry/talon/compare/v1.42.1...v1.42.2) (2026-07-11)


### Bug Fixes

* **watchdog:** idle is not a fault — warn only when work is actually stuck ([#526](https://github.com/thefalconry/talon/issues/526)) ([c0807dd](https://github.com/thefalconry/talon/commit/c0807ddf0152c647bb48245199323c1d03cba43f))

## [1.42.1](https://github.com/thefalconry/talon/compare/v1.42.0...v1.42.1) (2026-07-11)


### Bug Fixes

* **companion:** light DMG background — legible labels + Tahoe icon-bug fallback ([#524](https://github.com/thefalconry/talon/issues/524)) ([afda0a3](https://github.com/thefalconry/talon/commit/afda0a3245355893c74a71dab7241e44ac6e068c))

## [1.42.0](https://github.com/thefalconry/talon/compare/v1.41.0...v1.42.0) (2026-07-11)


### Features

* **ci:** conventional PR-title gate + faster Windows functional installs ([#522](https://github.com/thefalconry/talon/issues/522)) ([d65b619](https://github.com/thefalconry/talon/commit/d65b6193d46697c91fa0961ab3927896d977a75f))

## [1.41.0](https://github.com/thefalconry/talon/compare/v1.40.2...v1.41.0) (2026-07-11)


### Features

* **mesh:** device registry hygiene — dedupe stale installs, remove_device tool, macOS app polish ([#518](https://github.com/thefalconry/talon/issues/518)) ([dcff33d](https://github.com/thefalconry/talon/commit/dcff33d407b5c2f0ed161b3716ee66df57ad6207))


### Bug Fixes

* **companion:** backgrounded children no longer pin device exec open ([#519](https://github.com/thefalconry/talon/issues/519)) ([f871272](https://github.com/thefalconry/talon/commit/f8712727d57c4f1c79a3f61de5f8690d6acfb24c))

## [1.40.2](https://github.com/thefalconry/talon/compare/v1.40.1...v1.40.2) (2026-07-11)


### Bug Fixes

* **dream:** failure backoff for memory consolidation, shared with heartbeat ([#516](https://github.com/thefalconry/talon/issues/516)) ([e419ccd](https://github.com/thefalconry/talon/commit/e419ccda10e11102ea113486c7cf096934f687ca))

## [1.40.1](https://github.com/thefalconry/talon/compare/v1.40.0...v1.40.1) (2026-07-11)


### Bug Fixes

* **companion:** re-stage APK into /data/local/tmp before pm install ([#513](https://github.com/thefalconry/talon/issues/513)) ([78d5b65](https://github.com/thefalconry/talon/commit/78d5b650f86c1487899f8102a600c313c5f8133b))
* **companion:** run macOS exec through a zsh login shell ([#512](https://github.com/thefalconry/talon/issues/512)) ([dd16600](https://github.com/thefalconry/talon/commit/dd1660003f87c628969299fe589b972848ac1fd8))
* **heartbeat:** back off after failures instead of retrying every minute ([#514](https://github.com/thefalconry/talon/issues/514)) ([6a06c25](https://github.com/thefalconry/talon/commit/6a06c2583f59a50053b946f58c3adeac853128dd))

## [1.40.0](https://github.com/thefalconry/talon/compare/v1.39.0...v1.40.0) (2026-07-11)


### Features

* **memory:** mem0 backend, unified memory config + bug squash ([#500](https://github.com/thefalconry/talon/issues/500)) ([0db7653](https://github.com/thefalconry/talon/commit/0db7653ec0162f0abd2b675d4925a8bef1c44649))


### Bug Fixes

* **companion:** bounce stale Android mesh service ([#510](https://github.com/thefalconry/talon/issues/510)) ([9354df0](https://github.com/thefalconry/talon/commit/9354df00851351bb84b8afff823b16654454d347))

## [1.39.0](https://github.com/thefalconry/talon/compare/v1.38.1...v1.39.0) (2026-07-10)


### Features

* **mesh:** remote self-update for the Android companion (update_device) ([#506](https://github.com/thefalconry/talon/issues/506)) ([1786675](https://github.com/thefalconry/talon/commit/178667592fbde17faa3b33af013d378dc83bba4e))

## [1.38.1](https://github.com/thefalconry/talon/compare/v1.38.0...v1.38.1) (2026-07-10)


### Bug Fixes

* **delivery:** empty turns stay silent instead of posting a '(no reply)' notice ([#507](https://github.com/thefalconry/talon/issues/507)) ([f43c784](https://github.com/thefalconry/talon/commit/f43c7843dfa2acce6e038db211a8c8df2659e516))

## [1.38.0](https://github.com/thefalconry/talon/compare/v1.37.4...v1.38.0) (2026-07-10)


### Features

* **companion:** run the mesh loop inside the Android foreground service ([#503](https://github.com/thefalconry/talon/issues/503)) ([792bc4c](https://github.com/thefalconry/talon/commit/792bc4c821024e3fa6f34af7145efb2a53f52c1a))


### Bug Fixes

* **companion:** stop resurrecting stale backend-switch notices + chat UX polish ([#505](https://github.com/thefalconry/talon/issues/505)) ([4397cf3](https://github.com/thefalconry/talon/commit/4397cf334fa1bf157f9e6105ae26a53ece7a4469))

## [1.37.4](https://github.com/thefalconry/talon/compare/v1.37.3...v1.37.4) (2026-07-10)


### Bug Fixes

* **companion:** wait on ShizukuRemoteProcess with waitFor(), not exitValue polling ([#498](https://github.com/thefalconry/talon/issues/498)) ([c7bec03](https://github.com/thefalconry/talon/commit/c7bec03d78228186f416c27cd21cacec010ad75b))

## [1.37.3](https://github.com/thefalconry/talon/compare/v1.37.2...v1.37.3) (2026-07-10)


### Bug Fixes

* **companion:** keep Shizuku classes from R8 so reflective newProcess survives ([#496](https://github.com/thefalconry/talon/issues/496)) ([cb297d8](https://github.com/thefalconry/talon/commit/cb297d86646257d48671f0a73c062864f60cf522))

## [1.37.2](https://github.com/thefalconry/talon/compare/v1.37.1...v1.37.2) (2026-07-10)


### Bug Fixes

* **companion:** wait for the Shizuku binder + log every decision ([#494](https://github.com/thefalconry/talon/issues/494)) ([2fc1e84](https://github.com/thefalconry/talon/commit/2fc1e8459b2152f27ebfe88fd4475ab89a0eea66))

## [1.37.1](https://github.com/thefalconry/talon/compare/v1.37.0...v1.37.1) (2026-07-10)


### Bug Fixes

* **companion:** resolve Shizuku newProcess by name, not a pinned signature ([#492](https://github.com/thefalconry/talon/issues/492)) ([5374b21](https://github.com/thefalconry/talon/commit/5374b213fa1a7a780a72d887a22988a994222bab))

## [1.37.0](https://github.com/thefalconry/talon/compare/v1.36.0...v1.37.0) (2026-07-10)


### Features

* **metrics:** per-session, persistent, daily-bucketed metrics ([#480](https://github.com/thefalconry/talon/issues/480)) ([a27f61d](https://github.com/thefalconry/talon/commit/a27f61d5ecd1ade4befcf2839917f67d2759ef47))


### Bug Fixes

* **mesh:** explicit Shizuku privilege + exec/transfer infrastructure hardening ([#490](https://github.com/thefalconry/talon/issues/490)) ([09aea6b](https://github.com/thefalconry/talon/commit/09aea6bdcc07b931df99c4d2d170f175ce485d16))

## [1.36.0](https://github.com/thefalconry/talon/compare/v1.35.0...v1.36.0) (2026-07-09)


### Features

* native tools + teleport + mesh exec/fs + Shizuku ([#487](https://github.com/thefalconry/talon/issues/487)) ([c68a186](https://github.com/thefalconry/talon/commit/c68a1867112ba158d11d428d8f71613213cc1183))

## [1.35.0](https://github.com/thefalconry/talon/compare/v1.34.1...v1.35.0) (2026-07-08)


### Features

* **companion:** device mesh — locate, ring, history & telemetry from every frontend ([#483](https://github.com/thefalconry/talon/issues/483)) ([c3fb60e](https://github.com/thefalconry/talon/commit/c3fb60ed25dd876263455468ad5dd0f397d620df))

## [1.34.1](https://github.com/thefalconry/talon/compare/v1.34.0...v1.34.1) (2026-07-08)


### Bug Fixes

* **native:** classify delivery tools at the source instead of client name-matching ([#478](https://github.com/thefalconry/talon/issues/478)) ([cd411cf](https://github.com/thefalconry/talon/commit/cd411cf22562c236689f8e44a71a705ba07b8450))

## [1.34.0](https://github.com/thefalconry/talon/compare/v1.33.0...v1.34.0) (2026-07-08)


### Features

* verbose error passthrough + daemon log viewer in companion ([#474](https://github.com/thefalconry/talon/issues/474)) ([e50019b](https://github.com/thefalconry/talon/commit/e50019b903fa9c5e8330e17774248e4a01e28bf1))

## [1.33.0](https://github.com/thefalconry/talon/compare/v1.32.1...v1.33.0) (2026-07-07)


### Features

* **companion:** Android navigation + touch overhaul ([#471](https://github.com/thefalconry/talon/issues/471)) ([d8943d9](https://github.com/thefalconry/talon/commit/d8943d9283cf45bb37488c74d88189f673275028))

## [1.32.1](https://github.com/thefalconry/talon/compare/v1.32.0...v1.32.1) (2026-07-07)


### Bug Fixes

* **companion:** gate turn on delivery-tool readiness + responsive header ([#467](https://github.com/thefalconry/talon/issues/467)) ([4bfe5d8](https://github.com/thefalconry/talon/commit/4bfe5d849c6788d39f596a9f9759ab891dcf944d))

## [1.32.0](https://github.com/thefalconry/talon/compare/v1.31.0...v1.32.0) (2026-07-06)


### Features

* **companion:** context usage, controls, tool-timeline, synced message queue, light-mode code blocks ([#464](https://github.com/thefalconry/talon/issues/464)) ([c445970](https://github.com/thefalconry/talon/commit/c4459706c7e9ef9366676f7de4c2736fede8495c))
* **memory:** Phase B pre-retrieval plumbing — types, formatter, weaver hook, trust policy (inert) ([#462](https://github.com/thefalconry/talon/issues/462)) ([8b46ff2](https://github.com/thefalconry/talon/commit/8b46ff2636803f96300b22518f14977cb6b73079))

## [1.31.0](https://github.com/thefalconry/talon/compare/v1.30.1...v1.31.0) (2026-07-04)


### Features

* **soul:** per-node-kind decay stratification — reflexes never soften, spine fades faster ([#460](https://github.com/thefalconry/talon/issues/460)) ([e214ee1](https://github.com/thefalconry/talon/commit/e214ee16e0763c9e4419d121685f360f7e6c1e44))

## [1.30.1](https://github.com/thefalconry/talon/compare/v1.30.0...v1.30.1) (2026-07-04)


### Bug Fixes

* multi-fire watchers killed by restart now deliver a death notice ([#458](https://github.com/thefalconry/talon/issues/458)) ([9a3b078](https://github.com/thefalconry/talon/commit/9a3b078c93df94b07d8fa1f6e9d3e77bc26ad982))

## [1.30.0](https://github.com/thefalconry/talon/compare/v1.29.4...v1.30.0) (2026-07-04)


### Features

* model-drift detection — audit config pins, warn on substitution ([#455](https://github.com/thefalconry/talon/issues/455)) ([b0bf519](https://github.com/thefalconry/talon/commit/b0bf519017e784a609e3b2282c7c6b89e1433d91))


### Bug Fixes

* emit tool_result events — companion-app tool spinners resolve ([#456](https://github.com/thefalconry/talon/issues/456)) ([3e2a665](https://github.com/thefalconry/talon/commit/3e2a665f595b2b2ccacb427065f915d46b20a338))

## [1.29.4](https://github.com/thefalconry/talon/compare/v1.29.3...v1.29.4) (2026-07-03)


### Bug Fixes

* **companion:** one falcon mark everywhere, rework icon proportions, fix light-mode + Android theming ([#446](https://github.com/thefalconry/talon/issues/446)) ([a6b49c5](https://github.com/thefalconry/talon/commit/a6b49c5b7ec6191718b07293f677d600e4237f68))

## [1.29.3](https://github.com/thefalconry/talon/compare/v1.29.2...v1.29.3) (2026-07-02)


### Bug Fixes

* **publish:** fix nfpm .deb build — ${BIN} not expanded in contents[].src ([#444](https://github.com/thefalconry/talon/issues/444)) ([12559d8](https://github.com/thefalconry/talon/commit/12559d8108fd43a5738e3b25fe0432b7d2af4173))

## [1.29.2](https://github.com/thefalconry/talon/compare/v1.29.1...v1.29.2) (2026-07-01)


### Bug Fixes

* stability sweep — flaky tests, frontend drift bugs, consolidation ([#442](https://github.com/thefalconry/talon/issues/442)) ([9700b49](https://github.com/thefalconry/talon/commit/9700b49612e216aa4ff4f1f0acfe41a7a45e2ccb))

## [1.29.1](https://github.com/thefalconry/talon/compare/v1.29.0...v1.29.1) (2026-07-01)


### Bug Fixes

* **companion,native:** image rendering, phantom backend reset, light/dark/auto theming ([#440](https://github.com/thefalconry/talon/issues/440)) ([c14e385](https://github.com/thefalconry/talon/commit/c14e38505126a58b6802ce1ed7d9dbb11a61f3e6))

## [1.29.0](https://github.com/thefalconry/talon/compare/v1.28.0...v1.29.0) (2026-07-01)


### Features

* **companion,native:** bug fixes, protocol v1 extensions, offline-first app, UI system upgrade ([#438](https://github.com/thefalconry/talon/issues/438)) ([4224ee4](https://github.com/thefalconry/talon/commit/4224ee4a11b641f42eaf49e5d3ac630ee1a4108b))

## [1.28.0](https://github.com/thefalconry/talon/compare/v1.27.1...v1.28.0) (2026-07-01)


### Features

* **companion:** minimal, modern UI polish with flutter_animate ([#434](https://github.com/thefalconry/talon/issues/434)) ([9b9e376](https://github.com/thefalconry/talon/commit/9b9e3763e2a482d42db38d0b638b3f2b83928a99))

## [1.27.1](https://github.com/thefalconry/talon/compare/v1.27.0...v1.27.1) (2026-07-01)


### Bug Fixes

* **companion:** open a chat on the newest message, not the top ([ea5a220](https://github.com/thefalconry/talon/commit/ea5a22017e25348ce10134235320a88d2ec2a5f8))
* **companion:** open a chat on the newest message, not the top ([#432](https://github.com/thefalconry/talon/issues/432)) ([ea5a220](https://github.com/thefalconry/talon/commit/ea5a22017e25348ce10134235320a88d2ec2a5f8))

## [1.27.0](https://github.com/thefalconry/talon/compare/v1.26.0...v1.27.0) (2026-07-01)


### Features

* **companion:** minimal Talon bird app icon + finish Windows "Talon" naming ([41e1b54](https://github.com/thefalconry/talon/commit/41e1b549368e30cb74b00f2556f03d3a60cd3536))
* **companion:** minimal Talon bird app icon + finish Windows "Talon" naming ([b70f08f](https://github.com/thefalconry/talon/commit/b70f08fe1ad93aaeb93c9a28d8d3e256c57b5af6))
* **companion:** minimal Talon bird app icon + finish Windows Talon naming ([#429](https://github.com/thefalconry/talon/issues/429)) ([41e1b54](https://github.com/thefalconry/talon/commit/41e1b549368e30cb74b00f2556f03d3a60cd3536))
* **companion:** zero-config local mode via ~/.talon/native-bridge.json discovery ([fd1d2e9](https://github.com/thefalconry/talon/commit/fd1d2e95980e73dcdf8cafb605de2b4dd36d0bdf))
* **companion:** zero-config local mode via ~/.talon/native-bridge.json discovery ([a434967](https://github.com/thefalconry/talon/commit/a4349676ef2982f08099a69c3a1cfb7726368534))
* **companion:** zero-config local mode via ~/.talon/native-bridge.json discovery ([#427](https://github.com/thefalconry/talon/issues/427)) ([fd1d2e9](https://github.com/thefalconry/talon/commit/fd1d2e95980e73dcdf8cafb605de2b4dd36d0bdf))


### Bug Fixes

* **companion:** per-backend model list + persist attached images in history ([ed5eab6](https://github.com/thefalconry/talon/commit/ed5eab6a6fc155b734d821518827a05b158c31f1))
* **companion:** per-backend model list + persist attached images in history ([5c24566](https://github.com/thefalconry/talon/commit/5c2456662188f73736ee3ca6b1bea3c7f0e9f162))
* **companion:** per-backend model list + persist attached images in history ([#428](https://github.com/thefalconry/talon/issues/428)) ([ed5eab6](https://github.com/thefalconry/talon/commit/ed5eab6a6fc155b734d821518827a05b158c31f1))
* **companion:** re-fetch history on reconnect so messages aren't missed ([47158bc](https://github.com/thefalconry/talon/commit/47158bc78554be95f4a27c9554ee19bd2345b647))
* **companion:** re-fetch history on reconnect so messages aren't missed ([55ea859](https://github.com/thefalconry/talon/commit/55ea859b8954b7db62ea75f29e77aafaf8ae1a59))
* **companion:** re-fetch history on reconnect so messages aren't missed ([#430](https://github.com/thefalconry/talon/issues/430)) ([47158bc](https://github.com/thefalconry/talon/commit/47158bc78554be95f4a27c9554ee19bd2345b647))

## [1.26.0](https://github.com/thefalconry/talon/compare/v1.25.0...v1.26.0) (2026-07-01)


### Features

* **companion:** show the app as "Talon" instead of "talon_companion" ([276b76b](https://github.com/thefalconry/talon/commit/276b76b827d30c960dfd307d9740dadcd341f9e3))
* **companion:** show the app as "Talon" instead of "talon_companion" ([5b52ab6](https://github.com/thefalconry/talon/commit/5b52ab6211aa6db31d923063c5f06a0e0416072b))
* **companion:** show the app as "Talon" instead of "talon_companion" ([#425](https://github.com/thefalconry/talon/issues/425)) ([276b76b](https://github.com/thefalconry/talon/commit/276b76b827d30c960dfd307d9740dadcd341f9e3))

## [1.25.0](https://github.com/thefalconry/talon/compare/v1.24.5...v1.25.0) (2026-07-01)


### Features

* **companion:** expand settings with a Diagnostics "doctor" + About ([3cce179](https://github.com/thefalconry/talon/commit/3cce179ac347808455f4afa27f05dd34ac03dfc2))
* **companion:** let the user attach and send images to the bot ([34bfd8a](https://github.com/thefalconry/talon/commit/34bfd8a11da9962bb0918f6fca109ee7e8cb7467))
* **companion:** make all enabled backends selectable, not just Claude ([4a3f6c6](https://github.com/thefalconry/talon/commit/4a3f6c6d3d834671c7db79dce8a47afc5424ac30))
* **companion:** render images the bot sends (send_photo → inline image) ([69cbb75](https://github.com/thefalconry/talon/commit/69cbb759a7b3ae06edaaa2e4ca16dbd9bb79e88e))
* **companion:** tasteful motion pass — entrances, send button, tiles ([8692953](https://github.com/thefalconry/talon/commit/8692953c34a1db15eb8ad3c82eead6688fed3f9d))


### Bug Fixes

* **companion:** force compileSdk 36 on all Android plugin subprojects ([7860a3c](https://github.com/thefalconry/talon/commit/7860a3c759902172353ea256a4962b031f4814eb))
* **companion:** pin Android compileSdk to 36 for file_picker ([196e538](https://github.com/thefalconry/talon/commit/196e538833fa6bd5dc2df5c414ba3c0970354da2))
* **companion:** pin flutter_plugin_android_lifecycle to 2.0.24 ([c767c11](https://github.com/thefalconry/talon/commit/c767c11cd6ee36529dcaae10c54684ad58d11a17))
* **companion:** set plugin compileSdk via plugins.withId, not afterEvaluate ([44ffa8f](https://github.com/thefalconry/talon/commit/44ffa8f6da690dd9bd7fbc075a6016340a79e786))
* **companion:** stop tool-chip elapsed time from clipping + de-noise names ([31f5f4c](https://github.com/thefalconry/talon/commit/31f5f4c845f908abbcd9f8158147c752d0447b54))
* **native:** give the model the user message id so reactions target it ([3cd9ac8](https://github.com/thefalconry/talon/commit/3cd9ac8f3eaceaedc0358fb2200652c288d8a0b9))
* **native:** name new chats instantly from the first message ([1004e4c](https://github.com/thefalconry/talon/commit/1004e4c43dcf0156046ecebdbad8c291213dbbf5))

## [1.24.5](https://github.com/thefalconry/talon/compare/v1.24.4...v1.24.5) (2026-06-30)


### Bug Fixes

* **companion:** switch styling collapses to a solid blob; composer hidden by keyboard ([#413](https://github.com/thefalconry/talon/issues/413)) ([68df2c6](https://github.com/thefalconry/talon/commit/68df2c6504f71c9df0f455e18573f0712f53251d))

## [1.24.4](https://github.com/thefalconry/talon/compare/v1.24.3...v1.24.4) (2026-06-30)


### Bug Fixes

* **companion:** missing INTERNET permission broke Android release builds ([#411](https://github.com/thefalconry/talon/issues/411)) ([1b6df67](https://github.com/thefalconry/talon/commit/1b6df67ba6b1ad2d6176915a1d9f901e5a323848))

## [1.24.3](https://github.com/thefalconry/talon/compare/v1.24.2...v1.24.3) (2026-06-30)


### Bug Fixes

* **companion:** macOS network-client entitlement + connection diagnostics ([#405](https://github.com/thefalconry/talon/issues/405)) ([6a899d3](https://github.com/thefalconry/talon/commit/6a899d3d527d4b22e2b1a5d7dc5f7fca8305f865))

## [1.24.2](https://github.com/thefalconry/talon/compare/v1.24.1...v1.24.2) (2026-06-30)


### Bug Fixes

* **ci:** broken YAML in companion-scaffold.yml blocked workflow_dispatch ([#407](https://github.com/thefalconry/talon/issues/407)) ([423e45f](https://github.com/thefalconry/talon/commit/423e45fa3a4b4f04aa62d462391be7973ca39e43))

## [1.24.1](https://github.com/thefalconry/talon/compare/v1.24.0...v1.24.1) (2026-06-30)


### Bug Fixes

* **companion:** Windows build, source-build auto-start, UI fixes + npuw plugin ([#397](https://github.com/thefalconry/talon/issues/397)) ([1977720](https://github.com/thefalconry/talon/commit/1977720f60d560f28ee5919e628802a637038714))

## [1.24.0](https://github.com/thefalconry/talon/compare/v1.23.0...v1.24.0) (2026-06-30)


### Features

* **dist:** self-contained standalone binary + multi-platform release ([#358](https://github.com/thefalconry/talon/issues/358)) ([9d2789f](https://github.com/thefalconry/talon/commit/9d2789fb301a937d05eddcdcaab0906d5581abe7))
* run multiple frontends concurrently + rename desktop frontend to native ([#396](https://github.com/thefalconry/talon/issues/396)) ([7d9676a](https://github.com/thefalconry/talon/commit/7d9676ae020b48f2f3d28ca7c7bd2cba3cb56b6b))

## [1.23.0](https://github.com/thefalconry/talon/compare/v1.22.0...v1.23.0) (2026-06-30)


### Features

* **companion:** harden bridge pairing, add functional tests + CI + instrumentation ([#394](https://github.com/thefalconry/talon/issues/394)) ([cd07a26](https://github.com/thefalconry/talon/commit/cd07a2685be0a5307758b19a11bd100739d8495d))

## [1.22.0](https://github.com/thefalconry/talon/compare/v1.21.1...v1.22.0) (2026-06-29)


### Features

* **desktop:** client-bridge frontend + Flutter companion app ([#389](https://github.com/thefalconry/talon/issues/389)) ([44bcb73](https://github.com/thefalconry/talon/commit/44bcb7312eebcf9cebe4db14fdd73a84ad80ca80))
* **weaver:** unified thread/chat manager (scaffold + dispatcher rewire) ([#388](https://github.com/thefalconry/talon/issues/388)) ([2e6b5ae](https://github.com/thefalconry/talon/commit/2e6b5ae785fd3130bfe5ead23a29af439cafc9f5))

## [1.21.1](https://github.com/thefalconry/talon/compare/v1.21.0...v1.21.1) (2026-06-29)


### Bug Fixes

* **update:** /update force-syncs to remote instead of failing on a dirty tree ([#386](https://github.com/thefalconry/talon/issues/386)) ([d7a4757](https://github.com/thefalconry/talon/commit/d7a4757f74c3d8a987d3af614985859fbd2716e8))

## [1.21.0](https://github.com/thefalconry/talon/compare/v1.20.0...v1.21.0) (2026-06-28)


### Features

* **scheduler:** native catch-up + interval/one-shot/bounded cron jobs ([#356](https://github.com/thefalconry/talon/issues/356)) ([f660055](https://github.com/thefalconry/talon/commit/f6600553c7a0d9e59f0d4cea274a6994e986844e))

## [1.20.0](https://github.com/thefalconry/talon/compare/v1.19.0...v1.20.0) (2026-06-28)


### Features

* **cron:** isolated one-shot cron query jobs + backend-capability guards ([#361](https://github.com/thefalconry/talon/issues/361)) ([7064734](https://github.com/thefalconry/talon/commit/706473461ee26061064e2314ec7564efe065161e))
* **models:** list_models reads any registered backend, not just active ones ([#360](https://github.com/thefalconry/talon/issues/360)) ([b2a9fd1](https://github.com/thefalconry/talon/commit/b2a9fd16361a450be68e07640ac4950243ee6a41))


### Bug Fixes

* **ci:** merge-queue updates branches via PAT push so CI actually fires ([#384](https://github.com/thefalconry/talon/issues/384)) ([5f3fc07](https://github.com/thefalconry/talon/commit/5f3fc070505b9d513feee198bc49c75ed8ca6d50))
* **claude-sdk:** wait for MCP servers to connect after refreshTools ([#380](https://github.com/thefalconry/talon/issues/380)) ([8d07a9d](https://github.com/thefalconry/talon/commit/8d07a9d62c55ed56c529f7aa471bac04094df190))
* **mcp:** resolve tsx to an absolute path in the supervisor re-invocation ([c804fa5](https://github.com/thefalconry/talon/commit/c804fa5ec50990eb446713db3b566e90fde9e40a))
* **mcp:** resolve tsx to an absolute path in the supervisor re-invocation ([922d357](https://github.com/thefalconry/talon/commit/922d357a3ae3c40afdf89181b05f1d053f1b61ee))
* stop double startup on port retry and end_turn nag in terminal mode ([#381](https://github.com/thefalconry/talon/issues/381)) ([b5353a2](https://github.com/thefalconry/talon/commit/b5353a26f7e05c63c952ea387532b4b9957a7e44))
* **tools:** make Discord snowflake IDs string-typed (coerce numbers to string) ([ff254b8](https://github.com/thefalconry/talon/commit/ff254b88f10f2927866a91080a96106a618fa873))

## [1.19.0](https://github.com/thefalconry/talon/compare/v1.18.0...v1.19.0) (2026-06-17)


### Features

* **commands:** add /update self-update command for dev git checkouts ([#345](https://github.com/thefalconry/talon/issues/345)) ([343a69f](https://github.com/thefalconry/talon/commit/343a69f384cd975be0f1a0262642a2e3afef01d3))
* **jobs:** per-trigger/per-cron custom model (same backend) + model discovery tools ([#355](https://github.com/thefalconry/talon/issues/355)) ([c3b887f](https://github.com/thefalconry/talon/commit/c3b887fcdece00f2b68efdd22b51c30a4a5df812))
* **soul:** live signal taps — reactions, directives, corrections ([#353](https://github.com/thefalconry/talon/issues/353)) ([78ec9bf](https://github.com/thefalconry/talon/commit/78ec9bf344753d361d6ec1390c97fd4d827992be))
* **soul:** the Soul Kernel — a model-free, self-organizing identity substrate ([#349](https://github.com/thefalconry/talon/issues/349)) ([fa503c4](https://github.com/thefalconry/talon/commit/fa503c40ce2b305d19ac0783440ea8c72bad1450))
* **soul:** wire the Soul Kernel into the runtime (gated, off by default) ([#350](https://github.com/thefalconry/talon/issues/350)) ([71fc3ea](https://github.com/thefalconry/talon/commit/71fc3ea4cac0089b4eae518c26aa7cfcb77e916f))
* **warden:** supervise trigger trees on Windows via Job Objects ([#348](https://github.com/thefalconry/talon/issues/348)) ([dbf8852](https://github.com/thefalconry/talon/commit/dbf8852d38195592f390f4606e7e3e93636a14f3))


### Bug Fixes

* **mcp:** stop double-wrapping plugin MCP servers ([#337](https://github.com/thefalconry/talon/issues/337)) ([cceee54](https://github.com/thefalconry/talon/commit/cceee54f512f762afd48c7603e0b232d58f2c03e))

## [1.18.0](https://github.com/thefalconry/talon/compare/v1.17.0...v1.18.0) (2026-06-14)


### Features

* **native:** blake3-napi — in-process napi-rs addon for media hashing ([#328](https://github.com/thefalconry/talon/issues/328)) ([ba22e94](https://github.com/thefalconry/talon/commit/ba22e94fda9dd6b72ba824971b6b8475310daf2a))
* **native:** talon-warden — Rust supervision harness for trigger children ([#326](https://github.com/thefalconry/talon/issues/326)) ([91cd62f](https://github.com/thefalconry/talon/commit/91cd62f6957022a377d60f0d33b8840e413f58ab))
* **skills:** SKILL.md skill bundles + rename executable skills→scripts ([#333](https://github.com/thefalconry/talon/issues/333)) ([9847322](https://github.com/thefalconry/talon/commit/98473222a88d1d31723b32757b371a53386cc404))
* **stats:** real-time stats for all backends + robust failed-turn accounting ([#327](https://github.com/thefalconry/talon/issues/327)) ([7796983](https://github.com/thefalconry/talon/commit/7796983c0593146f0f046f12fd0fffac8723f138))


### Bug Fixes

* **claude-sdk:** always-load frontend tool servers (no defer) ([#329](https://github.com/thefalconry/talon/issues/329)) ([c4a52e2](https://github.com/thefalconry/talon/commit/c4a52e287c92f1fb3cefff1b8c9827b6b3f4ffce))
* **codex:** record token usage when terminator aborts before turn.completed ([#324](https://github.com/thefalconry/talon/issues/324)) ([edc2e1e](https://github.com/thefalconry/talon/commit/edc2e1e6ede0e072557a2da83d5372c25213cd06))
* stderr readline crash risk and cron non-null assertion ([#335](https://github.com/thefalconry/talon/issues/335)) ([d5ea5ab](https://github.com/thefalconry/talon/commit/d5ea5abb3b206359a208f7db14cb1b13446062c5))

## [1.17.0](https://github.com/thefalconry/talon/compare/v1.16.0...v1.17.0) (2026-06-12)


### Features

* **agency:** persistent goals, goal-driven heartbeat, adaptive effort routing ([#315](https://github.com/thefalconry/talon/issues/315)) ([fba8f1c](https://github.com/thefalconry/talon/commit/fba8f1c9b97af6784b277364c7030d7224e73f69))
* **behaviour:** promise-backing rule, heartbeat on by default, encourage proactive outreach ([#318](https://github.com/thefalconry/talon/issues/318)) ([68d5c72](https://github.com/thefalconry/talon/commit/68d5c7234510ccaf73f29bf268a0042514c12df4))
* **metrics:** aggregate token + cache usage in unified turn metrics ([#303](https://github.com/thefalconry/talon/issues/303)) ([ca6f845](https://github.com/thefalconry/talon/commit/ca6f8455e2362a5daa29e437b37ea68a2b38f2d4))
* **native:** C + C++ modules, shared wasm runtime, native registry ([#319](https://github.com/thefalconry/talon/issues/319)) ([b84916b](https://github.com/thefalconry/talon/commit/b84916bea53a3bf32ed94ed4b94594ec6e6ca57d))
* **native:** C sqlguard module — SQL LIKE / FTS5 escaping for model-controlled input ([#323](https://github.com/thefalconry/talon/issues/323)) ([8201b82](https://github.com/thefalconry/talon/commit/8201b820361e56428c710f21318bdbabffa462fd))
* **native:** Gleam scheduler decision core — typed policy functions compiled to JS ([#307](https://github.com/thefalconry/talon/issues/307)) ([e1c4acc](https://github.com/thefalconry/talon/commit/e1c4accfdcf3625eb57272436fce9cac1b2e08d5))
* **native:** Rust→WASM BLAKE3 hashing module — first brick of the data/indexing plane ([#308](https://github.com/thefalconry/talon/issues/308)) ([300b869](https://github.com/thefalconry/talon/commit/300b869bee683a2be0e6513ad9c9d0d7c67aec41))
* **native:** talon-driver — native launcher binary for apt/brew/source ([#322](https://github.com/thefalconry/talon/issues/322)) ([8d12538](https://github.com/thefalconry/talon/commit/8d1253857f499a58ed606f9211a692d17b69e802))
* **native:** Zig→WASM message-splitting core; pipe blake3 + Gleam scheduler into runtime ([#312](https://github.com/thefalconry/talon/issues/312)) ([51005b8](https://github.com/thefalconry/talon/commit/51005b843f9a8cd36808f8419133375782534fa1))
* **storage:** migrate sessions, chat-settings, media-index to SQLite ([#306](https://github.com/thefalconry/talon/issues/306)) ([066a0b5](https://github.com/thefalconry/talon/commit/066a0b54d6d973b5f1ee3304949c00bfcf068075))
* **storage:** SQLite data layer — FTS5 chat history, repository pattern, Node 24 ([#305](https://github.com/thefalconry/talon/issues/305)) ([27cce68](https://github.com/thefalconry/talon/commit/27cce68ad423580a52c84ec31c19944eeb56d7e6))
* streaming BLAKE3 + due-driven heartbeat; Node-24 packaging alignment; auto release-please ([#313](https://github.com/thefalconry/talon/issues/313)) ([3cdb9fd](https://github.com/thefalconry/talon/commit/3cdb9fdba8b12b1c115a18734d9bac7fa78761f8))
* **telegram:** /doctor command — shared doctor core with native-module report ([#317](https://github.com/thefalconry/talon/issues/317)) ([97f62e4](https://github.com/thefalconry/talon/commit/97f62e491b6c65a4ee7d423f478a2fece1643ee8))
* **triggers:** Lua scripting language — WASM-sandboxed via wasmoon ([#309](https://github.com/thefalconry/talon/issues/309)) ([12fd90f](https://github.com/thefalconry/talon/commit/12fd90f54dff90ae2a6a9fa5c92fbb1170a51c20))


### Bug Fixes

* **daemon:** prevent duplicate daemons after /restart ([#301](https://github.com/thefalconry/talon/issues/301)) ([aeba50f](https://github.com/thefalconry/talon/commit/aeba50f19542187bdf5419099e5aea1006eb633e))
* four correctness bugs — infinite retry loop, FTS corruption, LIKE injection, nested transaction crash ([#310](https://github.com/thefalconry/talon/issues/310)) ([4cd2a01](https://github.com/thefalconry/talon/commit/4cd2a01fc9dcf9f3cb5567285a8cec3770981220))
* **metrics:** unify codex tool names, count failed MCP calls, fix count-histogram rendering ([#298](https://github.com/thefalconry/talon/issues/298)) ([be22f3f](https://github.com/thefalconry/talon/commit/be22f3f1399345bf9c9f8c49080cb7edd9023c08))

## [1.16.0](https://github.com/thefalconry/talon/compare/v1.15.1...v1.16.0) (2026-06-11)


### Features

* **agent-runtime:** finish architecture unification plan (Phases 3-7) ([#258](https://github.com/thefalconry/talon/issues/258)) ([d30d596](https://github.com/thefalconry/talon/commit/d30d5965eeaf7942957e84ecce3e856afc958526))
* pipe codex api call metrics ([#283](https://github.com/thefalconry/talon/issues/283)) ([31084c5](https://github.com/thefalconry/talon/commit/31084c5b1c50215a8d18da57e6cbcdb37d80ef76))


### Bug Fixes

* **claude-sdk:** detect Fable and show both 1M/non-1M variants ([#290](https://github.com/thefalconry/talon/issues/290)) ([bc8ae9e](https://github.com/thefalconry/talon/commit/bc8ae9e42c31bca711d8d7658d32b24666e0dadb))
* let Codex retry oversized text-block delivery ([#285](https://github.com/thefalconry/talon/issues/285)) ([eb95900](https://github.com/thefalconry/talon/commit/eb959001d7564093a94d835bd9ce2ea203a1d56d))
* recover from codex text-block delivery failures ([#284](https://github.com/thefalconry/talon/issues/284)) ([ee3b95c](https://github.com/thefalconry/talon/commit/ee3b95ccb688731f5fcf141dea29f6c510dfc8f4))


### Performance Improvements

* prompt-cache-friendly system prompt (boundary split + per-session freeze) ([#292](https://github.com/thefalconry/talon/issues/292)) ([60b8bc7](https://github.com/thefalconry/talon/commit/60b8bc738c7d79090c8bf781ef028de01b8626bb))
* stop statting every workspace file to render the prompt listing ([#293](https://github.com/thefalconry/talon/issues/293)) ([829ce5f](https://github.com/thefalconry/talon/commit/829ce5fe8bcba8e90bb7517c6d760b68b0509728))

## [1.15.1](https://github.com/thefalconry/talon/compare/v1.15.0...v1.15.1) (2026-06-07)


### Bug Fixes

* 19 correctness bugs from deep codebase review ([#268](https://github.com/thefalconry/talon/issues/268)) ([5686c26](https://github.com/thefalconry/talon/commit/5686c261c82d881a9df16a4af53e83e5bf9b508e))
* **agent-runtime:** correct three bugs in adapter and legacy-bridge ([#263](https://github.com/thefalconry/talon/issues/263)) ([c812129](https://github.com/thefalconry/talon/commit/c8121294494671aa6fb2a4146979fdeb308c8402))
* flag intervening group context before vague replies ([#251](https://github.com/thefalconry/talon/issues/251)) ([b2a4bcd](https://github.com/thefalconry/talon/commit/b2a4bcd24a50e85e787079609135a8c734e15f9a))
* four correctness bugs found during deep code review ([#270](https://github.com/thefalconry/talon/issues/270)) ([5bd97c4](https://github.com/thefalconry/talon/commit/5bd97c4239f28c7e09b2e9fff757d40fc73af1f6))
* thread fallback model through params instead of setChatModel ([#265](https://github.com/thefalconry/talon/issues/265)) ([9deda78](https://github.com/thefalconry/talon/commit/9deda7836242df88a0643f98c38a39bba3bfce50))

## [1.15.0](https://github.com/thefalconry/talon/compare/v1.14.0...v1.15.0) (2026-06-06)


### Features

* **agent-runtime:** consume ModelRef + Phase 3/5/6/7 prep infra ([#255](https://github.com/thefalconry/talon/issues/255)) ([4f614b8](https://github.com/thefalconry/talon/commit/4f614b86c1cab18ef33f24a77abd8697cd9ce863))
* **core:** agent-runtime types — Phase 1 of architecture unification ([#253](https://github.com/thefalconry/talon/issues/253)) ([b7b7649](https://github.com/thefalconry/talon/commit/b7b764978e5b124b564ab8ce54455e5ec1d9e854))
* **core:** resolveActiveModelRefForChat — Phase 2.1 (stacked on [#253](https://github.com/thefalconry/talon/issues/253)) ([#254](https://github.com/thefalconry/talon/issues/254)) ([373cecd](https://github.com/thefalconry/talon/commit/373cecde6fcc1c287a4f3a6964c970e0878a7dcf))


### Bug Fixes

* **callbacks:** swallow expired-callback errors from answerCallbackQuery ([#256](https://github.com/thefalconry/talon/issues/256)) ([f4a1e2d](https://github.com/thefalconry/talon/commit/f4a1e2dd03a6ab485f0f512632c5b7175a2dc876))
* consolidate open correctness fixes ([#246](https://github.com/thefalconry/talon/issues/246)) ([e1b95ad](https://github.com/thefalconry/talon/commit/e1b95ad1303b238f2451a2bb009133bb422cc84d))
* pass resolved chat model into backends ([#248](https://github.com/thefalconry/talon/issues/248)) ([1b5cb97](https://github.com/thefalconry/talon/commit/1b5cb97997e8f969b1687eb2a150af133af74adc))
* register per-model reasoning levels ([#247](https://github.com/thefalconry/talon/issues/247)) ([88fc5e4](https://github.com/thefalconry/talon/commit/88fc5e4ad317acda5d927f4746879827c1c36614))

## [1.14.0](https://github.com/thefalconry/talon/compare/v1.13.0...v1.14.0) (2026-05-21)


### Features

* **status:** hide cache section on backends that don't report it ([#238](https://github.com/thefalconry/talon/issues/238)) ([7c606bf](https://github.com/thefalconry/talon/commit/7c606bffc4ee7b683374eda7b1b694e8d4171d88))


### Bug Fixes

* **chat:** restore valid per-chat backend state ([#236](https://github.com/thefalconry/talon/issues/236)) ([b8b5756](https://github.com/thefalconry/talon/commit/b8b5756a4113d42f89f33c57f80f683852aa17a4))
* **codex:** detect usage exhaustion, fix misleading log, filter catalog by auth mode ([#239](https://github.com/thefalconry/talon/issues/239)) ([194cdb3](https://github.com/thefalconry/talon/commit/194cdb3e978bd11973ec6155c39cbe5945cac102))
* **codex:** read last_token_usage from rollout JSONL for accurate context fill ([#237](https://github.com/thefalconry/talon/issues/237)) ([1917f85](https://github.com/thefalconry/talon/commit/1917f858ea7a07c84fdcaa507c61cad0a9c8da9c))

## [1.13.0](https://github.com/thefalconry/talon/compare/v1.12.0...v1.13.0) (2026-05-21)


### Features

* Antigravity (Python SDK) + agy (local OAuth) backends + MCP supervisor refactor ([#224](https://github.com/thefalconry/talon/issues/224)) ([b8ba43f](https://github.com/thefalconry/talon/commit/b8ba43f80dfd7017f2bb789f4b34dde59cc6a6c0))
* **backend:** multi-role BackendPool + per-chat overrides + /model integration + openai-agents MCP fixes ([#211](https://github.com/thefalconry/talon/issues/211)) ([cb2a661](https://github.com/thefalconry/talon/commit/cb2a661e9c9fb109d3fd57b8441585d2f9eaafa5))
* **codex:** dynamic model discovery via OpenAI /v1/models ([#228](https://github.com/thefalconry/talon/issues/228)) ([6f88189](https://github.com/thefalconry/talon/commit/6f88189f040bf90432cddf81ec2d770058a03b21))


### Bug Fixes

* **claude-sdk:** post-result watchdog for stuck SDK iterator ([#218](https://github.com/thefalconry/talon/issues/218)) ([a6796d1](https://github.com/thefalconry/talon/commit/a6796d1fa5f8c1c07b1f6950e2a700281e9eb9ff))
* **claude-sdk:** preserve SDK loop on terminator delivery failure via SDK's native error pipeline ([#159](https://github.com/thefalconry/talon/issues/159)) ([9fefe59](https://github.com/thefalconry/talon/commit/9fefe59ec4dcdd50fc05a41dfef162c24122951a))
* **codex:** auto-approve MCP tools + run with full permissions ([#234](https://github.com/thefalconry/talon/issues/234)) ([14e55f0](https://github.com/thefalconry/talon/commit/14e55f08e5ee95977058926d1a90971f67b94eeb))
* **codex:** harden ChatGPT-OAuth model compat — silent-exit recovery + runtime learning ([#231](https://github.com/thefalconry/talon/issues/231)) ([892530a](https://github.com/thefalconry/talon/commit/892530ad30c9ab380d97480f724d8926cfb8a1d7))
* **codex:** isolate backend auth credentials ([#227](https://github.com/thefalconry/talon/issues/227)) ([088dd87](https://github.com/thefalconry/talon/commit/088dd87800b422ffde187db4de6264b22d140b55))
* **codex:** only mark turn terminated on `completed` mcp_tool_call status ([#233](https://github.com/thefalconry/talon/issues/233)) ([dea6f61](https://github.com/thefalconry/talon/commit/dea6f614421bfa04d44f0d8dcc9ccc22bf4faeef))
* **daemon+heartbeat:** silent crash on /restart and stuck heartbeat [#376](https://github.com/thefalconry/talon/issues/376) ([#223](https://github.com/thefalconry/talon/issues/223)) ([669ab82](https://github.com/thefalconry/talon/commit/669ab82751a102330605133cb2d835220f382288))
* **openai-agents:** persist turn memory + expand ~/ in send_* actions ([#208](https://github.com/thefalconry/talon/issues/208)) ([bf2b01b](https://github.com/thefalconry/talon/commit/bf2b01bbe95bfe1744db7721a62e95612b2bc627))

## [1.12.0](https://github.com/thefalconry/talon/compare/v1.11.0...v1.12.0) (2026-05-18)


### Features

* **backend:** add Codex as a fourth backend provider ([#174](https://github.com/thefalconry/talon/issues/174)) ([7d476b9](https://github.com/thefalconry/talon/commit/7d476b97c654bec047965a96a95fc82118539153))
* **backend:** add Kilo CLI as backend provider ([#161](https://github.com/thefalconry/talon/issues/161)) ([9263611](https://github.com/thefalconry/talon/commit/926361165a3d8773a8b3165fea875019dcb503a3))
* **backend:** add OpenAI Agents SDK as fifth backend ([#199](https://github.com/thefalconry/talon/issues/199)) ([d9a6e90](https://github.com/thefalconry/talon/commit/d9a6e90f29762e75600dd9557b234431ab47cbe4))
* **backend:** Kilo 1:1 with Claude SDK + shared framework + backend registry ([#169](https://github.com/thefalconry/talon/issues/169)) ([9ef3689](https://github.com/thefalconry/talon/commit/9ef368940589c7f1c45382603ec35e35214d7739))
* **claude-sdk:** add Notification and StopFailure hooks for SDK telemetry ([#128](https://github.com/thefalconry/talon/issues/128)) ([63c9cb8](https://github.com/thefalconry/talon/commit/63c9cb8afdd0e90167df0eec9fb0f70e131beb6a))
* **cli:** setup wizard prompts for Discord bot token + applicationId ([#185](https://github.com/thefalconry/talon/issues/185)) ([ed36c04](https://github.com/thefalconry/talon/commit/ed36c04aafa6b62b00d26f286ce142f9b2978190))
* **cli:** setup wizard supports backend selection + Discord frontend ([#180](https://github.com/thefalconry/talon/issues/180)) ([8a9fb78](https://github.com/thefalconry/talon/commit/8a9fb78623542d94af8f453bce18b457b5dafa6c))
* **codex:** factory cleanup hook + expanded conformance + parity log line ([#177](https://github.com/thefalconry/talon/issues/177)) ([077cf3b](https://github.com/thefalconry/talon/commit/077cf3b3cd265ad52cd9f69d0ec53ea8bcb985a6))
* **codex:** friendly startup warning when no auth source available ([#182](https://github.com/thefalconry/talon/issues/182)) ([5842517](https://github.com/thefalconry/talon/commit/5842517de2d6d8d647a339d0c564b2701ba2cf7b))
* **codex:** runOneShotAgent + full model registry + 4-way registry parity tests ([#175](https://github.com/thefalconry/talon/issues/175)) ([44ab734](https://github.com/thefalconry/talon/commit/44ab73404fe96d817185d0905d411e7b8dc34a59))
* **codex:** set sensible ThreadOptions defaults — sandbox / approval / network ([#183](https://github.com/thefalconry/talon/issues/183)) ([85e0d8c](https://github.com/thefalconry/talon/commit/85e0d8c076729863e39102ef6dbccfd31ddc9975))
* **discord:** show backend label in /status header ([#191](https://github.com/thefalconry/talon/issues/191)) ([d10cbea](https://github.com/thefalconry/talon/commit/d10cbeacbf83cfebc54b25bd91dad2615ebc4f5b))
* **frontend:** add Discord frontend (discord.js v14) ([#160](https://github.com/thefalconry/talon/issues/160)) ([625148c](https://github.com/thefalconry/talon/commit/625148cdcc6bdce683a220f178c530742b9f8984))
* **handlers:** surface user-quoted portions from reply context (Bot API 7.0) ([#157](https://github.com/thefalconry/talon/issues/157)) ([92210ec](https://github.com/thefalconry/talon/commit/92210ec4b401edabeed0657a9e6c3a90bd872180))
* **heartbeat:** outbound telegram — explicit chat_id routing ([#150](https://github.com/thefalconry/talon/issues/150)) ([77e7771](https://github.com/thefalconry/talon/commit/77e7771dca13e157f73f8c2e6dd4b73705b4f9f6))
* **picker:** backend-agnostic model picker — provider groups, persisted free filter, decoupled /settings ([#207](https://github.com/thefalconry/talon/issues/207)) ([91df6a9](https://github.com/thefalconry/talon/commit/91df6a92af4da005d35ffedaab0a584cbe0d7d51))
* **telegram:** show backend label in /status header ([#184](https://github.com/thefalconry/talon/issues/184)) ([9d18672](https://github.com/thefalconry/talon/commit/9d186729827a4feef79e96b2a7f44571b635f588))
* **tools:** expose Talon MCP tools to the Discord frontend ([#203](https://github.com/thefalconry/talon/issues/203)) ([a4a1ae3](https://github.com/thefalconry/talon/commit/a4a1ae3b192fa016d39fa3cb052335bbd2ca7934))
* **triggers:** add persistent triggers that survive Talon restarts ([#201](https://github.com/thefalconry/talon/issues/201)) ([40f4dd7](https://github.com/thefalconry/talon/commit/40f4dd7d7b55993f63f02e81cbee5c0462f3c489))
* **triggers:** self-authored watcher scripts that wake the bot ([#96](https://github.com/thefalconry/talon/issues/96)) ([cafc8d4](https://github.com/thefalconry/talon/commit/cafc8d4234218abb1e45621dccd36a0a367b01cc))


### Bug Fixes

* **heartbeat:** evict wedged SDK subprocesses, never deadlock the lock ([#144](https://github.com/thefalconry/talon/issues/144)) ([d17a4eb](https://github.com/thefalconry/talon/commit/d17a4ebbcb289fda2617ec84903622cdfbd67815))
* **heartbeat:** frontend-agnostic outbound + comprehensive test coverage ([#151](https://github.com/thefalconry/talon/issues/151)) ([85251d3](https://github.com/thefalconry/talon/commit/85251d329b31bcebc172568d39d700cd3d55bf08))
* **kilo:** make the chat flow actually work end-to-end ([#170](https://github.com/thefalconry/talon/issues/170)) ([8286706](https://github.com/thefalconry/talon/commit/8286706ac83fa346261d24179b722162a53232ff))
* **openai-agents:** isolate config from generic OPENAI_* env vars ([#206](https://github.com/thefalconry/talon/issues/206)) ([fc16cb2](https://github.com/thefalconry/talon/commit/fc16cb2ffba6cdcec51c50625ac309e5d5d6a60b))
* six correctness and safety bugs (timer leak, HTML injection, log component, flush consistency, status regex) ([#156](https://github.com/thefalconry/talon/issues/156)) ([7530244](https://github.com/thefalconry/talon/commit/753024462705035f57b15cbe82f1a330284a5026))
* **telegram:** escape backend modelDetails so /model and /settings render ([#164](https://github.com/thefalconry/talon/issues/164)) ([01f59ed](https://github.com/thefalconry/talon/commit/01f59edc2535dc5de08e57b2dd2b0ce0edc253c6))
* **tools:** chat_id schema accepts negative IDs for groups/channels ([#153](https://github.com/thefalconry/talon/issues/153)) ([9298246](https://github.com/thefalconry/talon/commit/92982468613022e2a040d62d1a69acbb9ff426b6))
* **tools:** mark react as a turn terminator (endsTurn: true) ([#148](https://github.com/thefalconry/talon/issues/148)) ([afb03ef](https://github.com/thefalconry/talon/commit/afb03ef962014c6f54a30c5c5b1ea1cc188678da))
* **tools:** preserve Discord snowflake IDs in tool input schemas ([#204](https://github.com/thefalconry/talon/issues/204)) ([f46efce](https://github.com/thefalconry/talon/commit/f46efce242ceaf008e069f47c6c088fb9b67058b))

## [1.11.0](https://github.com/thefalconry/talon/compare/v1.10.1...v1.11.0) (2026-05-11)


### Features

* **access:** capture unauthorized message bodies for forensics ([#135](https://github.com/thefalconry/talon/issues/135)) ([49e1029](https://github.com/thefalconry/talon/commit/49e10292b05ee1508a8221ac964662b72f415bb5))


### Bug Fixes

* **deps:** bump fast-uri 3.1.0→3.1.2 (Dependabot alerts [#7](https://github.com/thefalconry/talon/issues/7) + [#11](https://github.com/thefalconry/talon/issues/11)) ([#134](https://github.com/thefalconry/talon/issues/134)) ([0709805](https://github.com/thefalconry/talon/commit/0709805e7258d0306a061b603192e87ea1c2669b))

## [1.10.1](https://github.com/thefalconry/talon/compare/v1.10.0...v1.10.1) (2026-05-09)


### Bug Fixes

* **claude-sdk:** terminate SDK loop on end_turn (MCP-prefix match + PostToolBatch hook) ([#122](https://github.com/thefalconry/talon/issues/122)) ([a92452a](https://github.com/thefalconry/talon/commit/a92452af146ee7f73d6c8771e6e1509d0c71bf3d))
* **deps:** bump ip-address 10.1.0→10.2.0 to close Dependabot alert [#4](https://github.com/thefalconry/talon/issues/4) ([#120](https://github.com/thefalconry/talon/issues/120)) ([31b6f9d](https://github.com/thefalconry/talon/commit/31b6f9d1761a5d2526c748ed15a17e042e4189c0))

## [1.10.0](https://github.com/thefalconry/talon/compare/v1.9.2...v1.10.0) (2026-05-08)


### Features

* **messaging:** add end_turn tool + flow enforcement ([#108](https://github.com/thefalconry/talon/issues/108)) ([6a4f8ac](https://github.com/thefalconry/talon/commit/6a4f8aca8d7ca8d9528ce04bac38bea94a3080a2))

## [1.9.2](https://github.com/thefalconry/talon/compare/v1.9.1...v1.9.2) (2026-05-07)


### Bug Fixes

* cache hit % shouldn't include cache writes in denominator ([#107](https://github.com/thefalconry/talon/issues/107)) ([379eace](https://github.com/thefalconry/talon/commit/379eace4b823bc824eed3f60242c396c1202752a))
* **deps:** bump @anthropic-ai/sdk 0.86.1→0.95.0 to close Dependabot alert [#3](https://github.com/thefalconry/talon/issues/3) ([#113](https://github.com/thefalconry/talon/issues/113)) ([054516b](https://github.com/thefalconry/talon/commit/054516be39e58fff1bac2ba42d0f2060c16ad06d))
* **docker:** make container actually boot Talon end-to-end ([#106](https://github.com/thefalconry/talon/issues/106)) ([f44d05c](https://github.com/thefalconry/talon/commit/f44d05c7d688045a72a26cb68639dc6ff9be44c0))
* **gateway:** don't leak error details on unhandled 500 ([#104](https://github.com/thefalconry/talon/issues/104)) ([5a359db](https://github.com/thefalconry/talon/commit/5a359db0ea1d09dee4f9017f2790aecf05f8a508))
* **tools:** coerce stringified numeric IDs in tool input schemas ([#103](https://github.com/thefalconry/talon/issues/103)) ([bd4b103](https://github.com/thefalconry/talon/commit/bd4b10324419fcb41d35436a6ce8266523398032))

## [1.9.1](https://github.com/thefalconry/talon/compare/v1.9.0...v1.9.1) (2026-04-27)


### Bug Fixes

* **tools:** disallow ScheduleWakeup outside /loop mode ([#91](https://github.com/thefalconry/talon/issues/91)) ([75b15f0](https://github.com/thefalconry/talon/commit/75b15f0f1530fe3d457fc929317f40b649ef0ed2))

## [1.9.0](https://github.com/thefalconry/talon/compare/v1.8.1...v1.9.0) (2026-04-21)


### Features

* **mempalace:** support 3.3.x multi-language entity detection ([#72](https://github.com/thefalconry/talon/issues/72)) ([5da6e02](https://github.com/thefalconry/talon/commit/5da6e02a500f8ce7fe2266160b4d5d5513f1aae5))


### Bug Fixes

* **robustness:** launcher-wrapped MCP spawns + minimal silence watchdog ([#73](https://github.com/thefalconry/talon/issues/73)) ([37f41de](https://github.com/thefalconry/talon/commit/37f41de4b5cd0707122eed5f055e5fa47a2b5bf8))

## [1.8.1](https://github.com/thefalconry/talon/compare/v1.8.0...v1.8.1) (2026-04-17)


### Bug Fixes

* **security:** address CodeQL HTML sanitization findings ([#63](https://github.com/thefalconry/talon/issues/63)) ([39ac20b](https://github.com/thefalconry/talon/commit/39ac20b6f7ce7e33a3cfac75d1ac6cb4db93d680))

## [1.8.0](https://github.com/thefalconry/talon/compare/v1.7.0...v1.8.0) (2026-04-16)


### Features

* move Claude model logic to backend and remove model tiers ([#54](https://github.com/thefalconry/talon/issues/54)) ([99d6b73](https://github.com/thefalconry/talon/commit/99d6b73ba3a44bb6e91008a110bc9c3ec72390fc))
* **opencode:** add model catalog and fix delivery/status flows ([#57](https://github.com/thefalconry/talon/issues/57)) ([bb9a216](https://github.com/thefalconry/talon/commit/bb9a216721174e946876a5828a545926573d941e))

## [1.7.0](https://github.com/thefalconry/talon/compare/v1.6.1...v1.7.0) (2026-04-14)


### Features

* add standalone MCP server plugin support ([#52](https://github.com/thefalconry/talon/issues/52)) ([bf3cdc3](https://github.com/thefalconry/talon/commit/bf3cdc30d4d157f51433b70ef0968514dcb90c84))

## [1.6.1](https://github.com/thefalconry/talon/compare/v1.6.0...v1.6.1) (2026-04-13)


### Bug Fixes

* model switch doubling context usage ([#44](https://github.com/thefalconry/talon/issues/44)) ([032d8cc](https://github.com/thefalconry/talon/commit/032d8cce53be3cd626559348862b2fdc1ffe86d9))

## [1.6.0](https://github.com/thefalconry/talon/compare/v1.5.0...v1.6.0) (2026-04-13)


### Features

* add model registry middleware and dynamic model pickers ([#42](https://github.com/thefalconry/talon/issues/42)) ([6e68b6f](https://github.com/thefalconry/talon/commit/6e68b6f957dd2c3c24c9a16ff1137aa2ff8962c4))

## [1.5.0](https://github.com/thefalconry/talon/compare/v1.4.0...v1.5.0) (2026-04-12)


### Features

* add reload_plugins tool for hot-reloading MCP plugins ([#37](https://github.com/thefalconry/talon/issues/37)) ([ca72c4e](https://github.com/thefalconry/talon/commit/ca72c4e50507589daf30ad9ade50700487f6586a))
* give heartbeat access to all MCP plugins ([#33](https://github.com/thefalconry/talon/issues/33)) ([d148b90](https://github.com/thefalconry/talon/commit/d148b909021fafadb023b87f9b259bd214dbe7c9))
* warm-start sessions on /reset for immediate /status context data ([6956e41](https://github.com/thefalconry/talon/commit/6956e41599bede2242e6c91ed28b2b688dddfab6))


### Bug Fixes

* /status context bar — use SDK [1m] model suffix for correct context window ([ffa0b61](https://github.com/thefalconry/talon/commit/ffa0b61fa44b7a0cb53d87a562fba894e5cdf27a))
* await warmSession on /reset so context data is ready for /status ([3ef6c60](https://github.com/thefalconry/talon/commit/3ef6c60d55e7f2562f58f10bf5a2582f28ab0300))
* drain SDK stream during warm-up so control requests don't stall ([d46ef0d](https://github.com/thefalconry/talon/commit/d46ef0d40fc8d9a14abfe179babb65577331306d))
* regenerate lockfile with npm 10 for CI Node 22 compat ([0ff5eb7](https://github.com/thefalconry/talon/commit/0ff5eb783c9499145db4f47af68eb436adfb0534))

## [1.4.0](https://github.com/thefalconry/talon/compare/v1.3.0...v1.4.0) (2026-04-10)


### Features

* replace custom web search with Brave Search MCP server ([#30](https://github.com/thefalconry/talon/issues/30)) ([eeb9cf2](https://github.com/thefalconry/talon/commit/eeb9cf20b885a717baf875bb6a9b933099a57706))

## [1.3.0](https://github.com/thefalconry/talon/compare/v1.2.0...v1.3.0) (2026-04-10)


### Features

* integrate mempalace for long-term memory ([#27](https://github.com/thefalconry/talon/issues/27)) ([d68a3f2](https://github.com/thefalconry/talon/commit/d68a3f22b9076dadf9f35617defa901e7949e2ec))


### Bug Fixes

* **ci:** fix coverage validation, concurrency, format error handling ([d3a75af](https://github.com/thefalconry/talon/commit/d3a75af90abede3eea5160884c9c8a0ce0d4e821))
* patch SDK vulnerability, optimize CI, remove stryker ([833c791](https://github.com/thefalconry/talon/commit/833c79190a8d147ca995048a39797889e6b6b1c6))

## [1.2.0](https://github.com/thefalconry/talon/compare/v1.1.0...v1.2.0) (2026-04-09)


### Features

* **ci:** add mutation testing, coverage thresholds, and optimize pipeline ([32b446a](https://github.com/thefalconry/talon/commit/32b446a80a286947fbb338744f046141877c5abd))


### Bug Fixes

* **ci:** add manual trigger to release-please workflow ([c081d7f](https://github.com/thefalconry/talon/commit/c081d7fb61b7e111295be33d9cd750e6a6330cd4))
* **ci:** remove mutation testing job (too slow for CI) ([1573943](https://github.com/thefalconry/talon/commit/1573943cc120ed9e550ba9d7291a417a6c237e69))
* **ci:** restore PAT for release-please with updated token ([c602ede](https://github.com/thefalconry/talon/commit/c602ede3c8e5ad5f0563e17ec29c35a42aed656f))
* **ci:** track lockfile, add CodeQL, fix healthcheck, add smoke test ([ea32b5b](https://github.com/thefalconry/talon/commit/ea32b5bb08664fe4a4a28f50e451b9bfb4c6e053))
* **ci:** use GITHUB_TOKEN for release-please ([9ec44c5](https://github.com/thefalconry/talon/commit/9ec44c594c285adf030d049c0ccc5d82984d2cdc))
* **ci:** use PAT for release-please to trigger CI on PRs ([bec8e24](https://github.com/thefalconry/talon/commit/bec8e24dbbb904761d53c1037cadc549ce28e45a))
