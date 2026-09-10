import { Fragment } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { LayoutNode } from "../lib/layout";
import { useStore } from "../store";
import { TabGroup } from "./TabGroup";

function Node({ node }: { node: LayoutNode }) {
  const resizeSplit = useStore((s) => s.resizeSplit);
  if (node.kind === "group") return <TabGroup group={node} />;

  const horizontal = node.dir === "row";
  const key = node.children.map((c) => c.id).join("|");
  return (
    <Group
      key={key}
      orientation={horizontal ? "horizontal" : "vertical"}
      className="h-full w-full"
      onLayoutChanged={(layout, meta) => {
        if (!meta.isUserInteraction) return;
        resizeSplit(
          node.id,
          node.children.map((c) => layout[c.id] ?? 0),
        );
      }}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && (
            <Separator
              className={`${horizontal ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"} bg-neutral-800 transition-colors hover:bg-blue-500 data-[resize-handle-active]:bg-blue-500`}
            />
          )}
          <Panel id={child.id} defaultSize={`${node.sizes[i]}`} minSize="10">
            <Node node={child} />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}

export function Workbench() {
  const layout = useStore((s) => s.layout);
  if (!layout) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">
        No terminals yet. Click + in the sidebar to open one.
      </div>
    );
  }
  return (
    <div className="h-full w-full">
      <Node node={layout} />
    </div>
  );
}
