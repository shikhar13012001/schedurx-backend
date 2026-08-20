// Stable color assignment for doctors (by list order).

export const DOCTOR_COLORS = [
  "#4f46e5", // indigo
  "#0284c7", // sky
  "#059669", // emerald
  "#b45309", // amber
  "#dc2626", // red
  "#7c3aed", // violet
  "#db2777", // pink
  "#0f766e", // teal
];

export function doctorColor(index: number): string {
  return DOCTOR_COLORS[index % DOCTOR_COLORS.length];
}
