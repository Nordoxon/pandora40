import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";

export interface Site {
  id: string;
  url: string;
  label: string | null;
  telegram_chat_id: string;
  current_hash: string | null;
  last_checked_at: string | null;
  last_status: string | null;
  is_active: boolean;
}

export function SiteCard({ site }: { site: Site }) {
  const [checking, setChecking] = useState(false);

  const isError = site.last_status?.startsWith("error");
  const statusColor = !site.last_checked_at
    ? "bg-muted-foreground"
    : isError
      ? "bg-destructive"
      : "bg-primary";

  async function toggleActive(v: boolean) {
    const { error } = await supabase
      .from("watched_sites")
      .update({ is_active: v })
      .eq("id", site.id);
    if (error) toast.error(error.message);
  }

  async function checkNow() {
    setChecking(true);
    try {
      const { error } = await supabase.functions.invoke("check-sites", {
        body: { site_id: site.id },
      });
      if (error) throw error;
      toast.success("Проверка выполнена");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка проверки");
    } finally {
      setChecking(false);
    }
  }

  async function remove() {
    if (!confirm("Удалить этот сайт из мониторинга?")) return;
    const { error } = await supabase.from("watched_sites").delete().eq("id", site.id);
    if (error) toast.error(error.message);
    else toast.success("Удалено");
  }

  let host = site.url;
  try {
    host = new URL(site.url).hostname;
  } catch {}

  return (
    <Card className="p-5 bg-card/60 backdrop-blur border-border/80 hover:border-primary/40 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block size-2 rounded-full ${statusColor} ${site.is_active && !isError ? "pulse-dot" : ""}`}
            />
            <h3 className="font-mono-display text-base font-medium truncate">
              {site.label || host}
            </h3>
          </div>
          <a
            href={site.url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary truncate max-w-full"
          >
            <span className="truncate">{site.url}</span>
            <ExternalLink className="size-3 shrink-0" />
          </a>
        </div>
        <Switch checked={site.is_active} onCheckedChange={toggleActive} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-muted-foreground">Последняя проверка</div>
          <div className="font-mono-display mt-0.5">
            {site.last_checked_at
              ? formatDistanceToNow(new Date(site.last_checked_at), {
                  addSuffix: true,
                  locale: ru,
                })
              : "—"}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Статус</div>
          <div
            className={`font-mono-display mt-0.5 truncate ${
              isError ? "text-destructive" : "text-primary"
            }`}
          >
            {site.last_status ?? "ожидает"}
          </div>
        </div>
      </div>

      <div className="mt-3 text-xs text-muted-foreground font-mono-display">
        hash: {site.current_hash ? site.current_hash.slice(0, 16) + "…" : "—"}
      </div>

      <div className="mt-4 flex gap-2">
        <Button size="sm" variant="secondary" onClick={checkNow} disabled={checking} className="gap-1.5">
          <RefreshCw className={`size-3.5 ${checking ? "animate-spin" : ""}`} />
          Проверить
        </Button>
        <Button size="sm" variant="ghost" onClick={remove} className="gap-1.5 text-muted-foreground hover:text-destructive">
          <Trash2 className="size-3.5" />
          Удалить
        </Button>
      </div>
    </Card>
  );
}
