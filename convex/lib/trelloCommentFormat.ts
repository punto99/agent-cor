function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function splitTrailingPunctuation(value: string): {
  href: string;
  trailing: string;
} {
  const match = value.match(/^(.+?)([.,;:!?)]*)$/);
  if (!match) return { href: value, trailing: "" };

  return {
    href: match[1],
    trailing: match[2] || "",
  };
}

function anchorHtml(href: string, label?: string): string {
  const safeHref = escapeHtml(href.trim());
  const safeLabel = escapeHtml((label || href).trim());

  return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
}

export function formatTrelloCommentForCOR(message: string): string {
  const links: string[] = [];
  const markdownLinksReplaced = message.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g,
    (_fullMatch, label: string, href: string) => {
      const index = links.length;
      links.push(anchorHtml(href, label));
      return `__TRELLO_COR_LINK_${index}__`;
    },
  );

  const bareUrlsReplaced = markdownLinksReplaced.replace(
    /https?:\/\/[^\s<>"']+/g,
    (rawUrl) => {
      const { href, trailing } = splitTrailingPunctuation(rawUrl);
      const index = links.length;
      links.push(anchorHtml(href));
      return `__TRELLO_COR_LINK_${index}__${trailing}`;
    },
  );

  const escaped = escapeHtml(bareUrlsReplaced);

  return escaped.replace(
    /__TRELLO_COR_LINK_(\d+)__/g,
    (_fullMatch, index: string) => links[Number(index)] || "",
  );
}
