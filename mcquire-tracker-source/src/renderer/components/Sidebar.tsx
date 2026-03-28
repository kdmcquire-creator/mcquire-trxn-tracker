import type { Screen } from "../App"

interface Props {
  activeScreen: Screen
  onNavigate: (s: Screen) => void
  pendingCount: number
}

const ITEMS: { id: Screen; label: string; icon: string }[] = [
  { id: "dashboard",    label: "Dashboard",     icon: "📊" },
  { id: "review",       label: "Review Queue",  icon: "📋" },
  { id: "transactions", label: "Transactions",  icon: "💳" },
  { id: "reports",      label: "Reports",       icon: "📁" },
  { id: "investments",  label: "Investments",   icon: "📈" },
  { id: "settings",     label: "Settings",      icon: "⚙️" },
]

export default function Sidebar({ activeScreen, onNavigate, pendingCount }: Props) {
  return (
    <div className="w-56 min-h-screen flex flex-col" style={{ background: "#1F3864" }}>
      <div className="px-4 py-5 border-b border-white/10">
        <div className="text-white font-bold text-lg leading-tight">McQuire</div>
        <div className="text-blue-200 text-xs mt-0.5">Financial Tracker</div>
      </div>
      <nav className="flex-1 px-2 py-4 space-y-0.5">
        {ITEMS.map(item => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={`nav-item w-full text-left ${activeScreen === item.id ? "active" : ""}`}
          >
            <span className="text-base">{item.icon}</span>
            <span>{item.label}</span>
            {item.id === "review" && pendingCount > 0 && (
              <span className="ml-auto bg-orange-500 text-white text-xs rounded-full px-2 py-0.5 font-bold">
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="px-4 py-3 border-t border-white/10">
        <div className="text-blue-200 text-xs">Kyle McQuire</div>
        <div className="text-blue-300 text-xs">Peak 10 Energy</div>
      </div>
    </div>
  )
}
