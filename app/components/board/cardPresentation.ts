const labelColors: Record<string, string> = {
  green: "#4BCE97", yellow: "#F5CD47", orange: "#FEA362", red: "#F87168",
  purple: "#9F8FEF", blue: "#579DFF", sky: "#60C6D2", lime: "#94C748",
  pink: "#E774BB", black: "#8590A2",
  green_light: "#BAF3DB", yellow_light: "#F8E6A0", orange_light: "#FEC195", red_light: "#FFD5D2",
  purple_light: "#DFD8FD", blue_light: "#CCE0FF", sky_light: "#C6EDFB", lime_light: "#D3F1A7",
  pink_light: "#FDD0EC", black_light: "#DCDFE4",
  green_dark: "#1F845A", yellow_dark: "#946F00", orange_dark: "#C25100", red_dark: "#C9372C",
  purple_dark: "#6E5DC6", blue_dark: "#0C66E4", sky_dark: "#227D9B", lime_dark: "#5B7F24",
  pink_dark: "#AE4787", black_dark: "#626F86",
};

export function boardLabelColor(color?: string) {
  return labelColors[color ?? ""] ?? "#8590A2";
}

export function creatorInitials(name: string) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => Array.from(part)[0]).join("").toLocaleUpperCase();
}

export function cardDeadline(value: string | undefined, completed: boolean, now = new Date()) {
  if (!value?.trim()) return undefined;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[ T])/);
  if (!match) return { label: value, overdue: false, completed: false };
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) {
    return { label: value, overdue: false, completed: false };
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return {
    label: date.toLocaleDateString("es", { day: "numeric", month: "short", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } as const : {}) }).replace(".", ""),
    overdue: !completed && date < today,
    completed,
  };
}
