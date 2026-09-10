import { Sidebar } from "./components/Sidebar";
import { Workbench } from "./components/Workbench";
import "./lib/xtermRegistry";

export default function App() {
  return (
    <div className="flex h-full w-full">
      <Sidebar />
      <main className="min-w-0 flex-1">
        <Workbench />
      </main>
    </div>
  );
}
