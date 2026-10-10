/// Decodes the handful of HTML entities that leak into chat titles and
/// previews. Single pass on purpose: each `&...;` in the input is decoded at
/// most once, so `&amp;lt;` becomes the literal text `&lt;`, never `<`.
const _named = <String, String>{
  'quot': '"',
  'apos': "'",
  'lt': '<',
  'gt': '>',
  'nbsp': ' ',
  'amp': '&',
};

final _entity =
    RegExp(r'&(?:#x([0-9a-fA-F]+)|#(\d+)|(quot|apos|lt|gt|nbsp|amp));');

String unescapeHtml(String text) {
  if (!text.contains('&')) return text;
  return text.replaceAllMapped(_entity, (m) {
    final name = m[3];
    if (name != null) return _named[name] ?? m[0]!;
    final code =
        m[1] != null ? int.tryParse(m[1]!, radix: 16) : int.tryParse(m[2]!);
    if (code == null || code <= 0 || code > 0x10FFFF) return m[0]!;
    return code == 160 ? ' ' : String.fromCharCode(code);
  });
}
