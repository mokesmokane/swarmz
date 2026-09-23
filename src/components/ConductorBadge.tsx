/** The conductor's mark on rows, tabs and the hover card (conductor spec §6). */
export function ConductorBadge() {
  return (
    <span className="shrink-0 text-amber-300" title="The conductor: the one tile that acts on the others" aria-label="Conductor">
      🎛
    </span>
  );
}
