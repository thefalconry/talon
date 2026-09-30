/// Tool-name formatting shared by every surface that shows a tool call.
///
/// Pure Dart on purpose: the voice session (state layer) needs the same
/// phrasing the timeline (UI layer) uses, and state must not import widgets.
library;

/// De-noise MCP tool names for display:
/// `mcp__email-tools__search_emails` → `email · search_emails`.
/// Non-MCP names (e.g. `Bash`, `Read`) are shown as-is.
String toolDisplayName(String raw) {
  if (!raw.startsWith('mcp__')) return raw;
  final parts = raw.substring(5).split('__');
  if (parts.length < 2) return raw;
  var server = parts.first;
  if (server.endsWith('-tools')) {
    server = server.substring(0, server.length - '-tools'.length);
  }
  final tool = parts.sublist(1).join('__');
  return '$server · $tool';
}

/// The MCP server a tool belongs to (`mcp__email-tools__search_emails` →
/// `email`), or null for a built-in tool.
String? toolServer(String raw) {
  if (!raw.startsWith('mcp__')) return null;
  final parts = raw.substring(5).split('__');
  if (parts.length < 2) return null;
  var server = parts.first;
  if (server.endsWith('-tools')) {
    server = server.substring(0, server.length - '-tools'.length);
  }
  return server;
}

/// A human phrase for a tool, for surfaces that *narrate* rather than tabulate.
///
/// The chat timeline is a table: `email · search_emails` is right there, next
/// to arguments and a duration. Voice mode is a sentence read at a glance
/// while the phone sits on a table, and `mcp__email-tools__search_emails` is
/// unreadable in that position. Built-ins get hand-written phrases; anything
/// else is de-snake-cased into words and sentence-cased —
/// `search_emails` → "Search emails", `getWeather` → "Get weather".
String toolPhrase(String raw) {
  const builtins = <String, String>{
    'bash': 'Run a command',
    'shell': 'Run a command',
    'read': 'Read a file',
    'write': 'Write a file',
    'edit': 'Edit a file',
    'multiedit': 'Edit a file',
    'notebookedit': 'Edit a notebook',
    'glob': 'Find files',
    'grep': 'Search files',
    'websearch': 'Search the web',
    'webfetch': 'Read a page',
    'task': 'Run a subtask',
    'todowrite': 'Update the plan',
    'skill': 'Load a skill',
  };
  final tool = raw.startsWith('mcp__')
      ? (raw.substring(5).split('__')..removeAt(0)).join('__')
      : raw;
  final phrase = builtins[tool.toLowerCase().replaceAll(RegExp('[_-]'), '')];
  if (phrase != null) return phrase;
  final words = tool
      // snake_case and kebab-case (MCP servers use both) → spaced words.
      .replaceAll(RegExp('[_-]'), ' ')
      // camelCase / PascalCase → spaced words.
      .replaceAllMapped(RegExp(r'(?<=[a-z0-9])([A-Z])'), (m) => ' ${m[1]}')
      .trim()
      .toLowerCase();
  if (words.isEmpty) return raw;
  return words[0].toUpperCase() + words.substring(1);
}

/// A one-line, Claude-desktop-style summary of a run of tool calls, used as
/// the label of a collapsed tool group: `Ran 3 commands, read 2 files`.
///
/// Calls are bucketed by what they did (commands, reads, edits, searches, web,
/// everything else) and the buckets are listed in order of first appearance,
/// so the label reads in the order the work happened.
String toolGroupSummary(List<String> names) {
  if (names.isEmpty) return '';
  final counts = <_ToolKind, int>{};
  for (final n in names) {
    final kind = _toolKind(n);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  final parts = [for (final e in counts.entries) _kindPhrase(e.key, e.value)];
  final s = parts.join(', ');
  return s[0].toUpperCase() + s.substring(1);
}

enum _ToolKind { command, read, edit, search, web, agent, other }

_ToolKind _toolKind(String raw) {
  final tool = (raw.startsWith('mcp__')
          ? (raw.substring(5).split('__')..removeAt(0)).join('__')
          : raw)
      .toLowerCase()
      .replaceAll('_', '');
  // Names differ per backend (Claude Code, Codex, opencode, agy/Gemini), so
  // each bucket lists every spelling seen, normalised to lowercase with the
  // underscores dropped.
  const kinds = <_ToolKind, Set<String>>{
    _ToolKind.command: {
      'bash', 'shell', 'executecommand', 'deviceexec', 'runcommand',
      'execcommand', 'exec', 'localshell', 'commandexecution', 'runterminalcmd',
    },
    _ToolKind.read: {
      'read', 'notebookread', 'viewfile', 'readfile', 'openfile',
      'viewcodeitem', 'readmanyfiles',
    },
    _ToolKind.edit: {
      'write', 'edit', 'multiedit', 'notebookedit', 'writefile', 'editfile',
      'writetofile', 'createfile', 'applypatch', 'replacefilecontent',
      'multireplacefilecontent', 'replace', 'patch',
    },
    _ToolKind.search: {
      'glob', 'grep', 'search', 'grepsearch', 'findbyname', 'codebasesearch',
      'filesearch', 'listdir', 'listdirectory', 'ls', 'searchfiles',
    },
    _ToolKind.web: {
      'websearch', 'webfetch', 'fetchurl', 'searchweb', 'readurlcontent',
      'fetch', 'googlesearch',
    },
    _ToolKind.agent: {'task', 'agent', 'spawnagent'},
  };
  for (final e in kinds.entries) {
    if (e.value.contains(tool)) return e.key;
  }
  return _ToolKind.other;
}

String _kindPhrase(_ToolKind kind, int n) {
  String count(String one, String many) => n == 1 ? 'a $one' : '$n $many';
  switch (kind) {
    case _ToolKind.command:
      return 'ran ${count('command', 'commands')}';
    case _ToolKind.read:
      return 'read ${count('file', 'files')}';
    case _ToolKind.edit:
      return 'edited ${count('file', 'files')}';
    case _ToolKind.search:
      return n == 1 ? 'searched files' : 'searched files $n times';
    case _ToolKind.web:
      return n == 1 ? 'checked the web' : 'checked the web $n times';
    case _ToolKind.agent:
      return 'ran ${count('subtask', 'subtasks')}';
    case _ToolKind.other:
      return 'used ${count('tool', 'tools')}';
  }
}
