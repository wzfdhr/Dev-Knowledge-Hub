export function cspNonceFromDocument(document: Pick<Document, "querySelector">): string | undefined {
  const nonce = document.querySelector('meta[name="devkh-csp-nonce"]')?.getAttribute("content")?.trim();
  return nonce || undefined;
}
