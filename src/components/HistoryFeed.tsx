import { Card } from "@/components/ui/card";
import { AlertTriangle, CheckCircle2, Flag, Trophy, Pause } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import type { KortSite } from "./KortConfigCard";

export interface HistoryEntry {
  id: string;
  site_id: string;
  event_type: string;
  message: string | null;
  created_at: string;
}

export function HistoryFeed({ entries, site }: { entries: HistoryEntry[]; site: KortSite | null }) {
  if (entries.length === 0) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground bg-card/40 border-dashed">
        Пока ничего не произошло. История появится после первой проверки.
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {entries.map((e) => {
        const Icon =
          e.event_type === "season_open"
            ? Trophy
            : e.event_type === "season_close"
              ? Pause
              : e.event_type === "change"
                ? AlertTriangle
                : e.event_type === "error"
                  ? AlertTriangle
                  : e.event_type === "baseline"
                    ? Flag
                    : CheckCircle2;
        const tone =
          e.event_type === "season_open"
            ? "text-primary border-l-primary"
            : e.event_type === "season_close"
              ? "text-muted-foreground border-l-muted-foreground"
              : e.event_type === "change"
                ? "text-warning border-l-warning"
                : e.event_type === "error"
                  ? "text-destructive border-l-destructive"
                  : "text-primary border-l-primary";

        return (
          <div
            key={e.id}
            className={`flex items-start gap-3 rounded-md border-l-2 bg-card/40 px-4 py-3 ${tone}`}
          >
            <Icon className="size-4 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono-display text-sm truncate">
                  {site?.label || "kort40.online"}
                </span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {formatDistanceToNow(new Date(e.created_at), { addSuffix: true, locale: ru })}
                </span>
              </div>
              {e.message && (
                <p className="text-xs text-muted-foreground mt-0.5 break-words">{e.message}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
