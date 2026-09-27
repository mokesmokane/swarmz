import { TreeIcon } from "./sidebar/icons";

/** The conductor's mark on tabs and in the conductors panel: the sidebar's network icon. */
export function ConductorBadge() {
  return (
    <span className="flex shrink-0 text-needs" title="Conductor: acts on the tiles under it" aria-label="Conductor">
      <TreeIcon size={13} strokeWidth={1.4} />
    </span>
  );
}
