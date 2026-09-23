/** Read pasted text from every clipboard type browsers actually fill. */
export function readClipboardText(data: DataTransfer | null): string {
  if (!data) return '';
  for (const type of ['text/plain', 'text']) {
    try {
      const value = data.getData(type);
      if (value) return value;
    } catch {
      // A type the clipboard does not carry throws in some browsers.
    }
  }
  try {
    const html = data.getData('text/html');
    if (!html) return '';
    const text = html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    return text;
  } catch {
    return '';
  }
}
