import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "jp-theme";

function read(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Private windows and blocked site data both throw here. Falling back to
    // the OS preference is the right answer, not an error.
  }
  return "system";
}

function systemIsDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Apply the choice by stamping the root element.
 *
 * "system" removes the data-theme attribute so the CSS media query takes over,
 * and the .dark class is kept in sync for shadcn and Tailwind dark: variants.
 */
function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);

  const dark = theme === "dark" || (theme === "system" && systemIsDark());
  root.classList.toggle("dark", dark);
}

const ORDER: Theme[] = ["system", "light", "dark"];

const ICONS: Record<Theme, string> = {
  system: "M4 5h12v7H4zM2 14h16v1H2z",
  light: "M10 6a4 4 0 100 8 4 4 0 000-8zM10 1v2M10 17v2M3.5 3.5l1.4 1.4M15.1 15.1l1.4 1.4M1 10h2M17 10h2M3.5 16.5l1.4-1.4M15.1 4.9l1.4-1.4",
  dark: "M16 11.5A6.5 6.5 0 018.5 4a6.5 6.5 0 100 13 6.5 6.5 0 007.5-5.5z",
};

const LABELS: Record<Theme, string> = {
  system: "Theme: matching your system",
  light: "Theme: light",
  dark: "Theme: dark",
};

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(read);

  useEffect(() => {
    apply(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {}

    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const next = () => setTheme((t) => ORDER[(ORDER.indexOf(t) + 1) % ORDER.length]!);

  return (
    <button
      onClick={next}
      title={`${LABELS[theme]}. Click to change.`}
      aria-label={LABELS[theme]}
      className="rounded-lg p-2 text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
    >
      <svg
        viewBox="0 0 20 20"
        className="h-4 w-4"
        fill={theme === "dark" ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d={ICONS[theme]} />
      </svg>
    </button>
  );
}
