export function Logo({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <img
      src={size > 96 ? "/logo.png" : "/logo-128.png"}
      alt=""
      width={size}
      height={size}
      className={`shrink-0 select-none ${className}`}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}

export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2.5">
      <Logo size={size} />
      <span className="text-[15px] font-semibold tracking-tight">
        just<span className="text-accent">postgres</span>
      </span>
    </span>
  );
}
