// Share texts and app links for the Deliver step. The sender's own apps carry
// the link and the extra password; nothing here goes through VitalSend. The
// password text must never include the link or its key.

export const SHARE_ROUTES = ['sms', 'whatsapp', 'telegram', 'email'];

export function shareText(item, value) {
  if (item === 'password') return `The password for the file I sent you: ${value}`;
  return `A file for you. It can be downloaded once: ${value}`;
}

export function shareUrl(route, text) {
  const enc = encodeURIComponent(text);
  switch (route) {
    case 'sms': return `sms:?&body=${enc}`;
    case 'whatsapp': return `https://wa.me/?text=${enc}`;
    case 'telegram': return `https://t.me/share/url?url=&text=${enc}`;
    case 'email': return `mailto:?body=${enc}`;
    default: return '';
  }
}
