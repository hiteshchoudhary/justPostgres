import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function Loading({ rows = 3, className = "" }: { rows?: number; className?: string }) {
  return (
    <Card className={`gap-0 divide-y divide-border py-0 ${className}`}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="ml-auto h-4 w-20" />
        </div>
      ))}
      <span className="sr-only">Loading</span>
    </Card>
  );
}
