import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AddSiteDialog } from "@/components/AddSiteDialog";
import { SiteCard, type Site } from "@/components/SiteCard";
import { HistoryFeed, type HistoryEntry } from "@/components/HistoryFeed";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Activity, Bell, Send } from "lucide-react";

const CHAT_ID_KEY = "site-watcher.default-chat-id";

const Index = () => {
  const [sites, setSites] = useState<Site[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [defaultChatId, setDefaultChatId] = useState<string>(
    () => localStorage.getItem(CHAT_ID_KEY) ?? "",
  );
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    document.title = "Site Watcher — мониторинг изменений сайтов";
    const meta = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;
    if (meta) {
      meta.content =
        "Site Watcher — отслеживайте изменения HTML на любых страницах с уведомлениями в Telegram каждую минуту.";
    }
  }, []);

  async function loadAll() {
    const [{ data: s }, { data: h }] = await Promise.all([
      supabase.from("watched_sites").select("*").order("created_at", { ascending: false }),
      supabase
        .from("change_history")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    setSites((s ?? []) as Site[]);
    setHistory((h ?? []) as HistoryEntry[]);
  }

  useEffect(() => {
    loadAll();
    const ch = supabase
      .channel("site-watcher")
      .on("postgres_changes", { event: "*", schema: "public", table: "watched_sites" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "change_history" }, loadAll)
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  function saveChatId() {
    localStorage.setItem(CHAT_ID_KEY, defaultChatId.trim());
    toast.success("Сохранено как chat_id по умолчанию");
  }

  async function sendTest() {
    if (!defaultChatId.trim()) {
      toast.error("Сначала введите chat_id");
      return;
    }
    setTesting(true);
    try {
      const { error } = await supabase.functions.invoke("telegram-test", {
        body: { chat_id: defaultChatId.trim() },
      });
      if (error) throw error;
      toast.success("Тестовое сообщение отправлено в Telegram");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setTesting(false);
    }
  }

  const activeCount = sites.filter((s) => s.is_active).length;
  const errorCount = sites.filter((s) => s.last_status?.startsWith("error")).length;
  const changesCount = history.filter((h) => h.event_type === "change").length;

  return (
    <div className="relative min-h-screen">
      <div className="absolute inset-0 grid-bg pointer-events-none" aria-hidden />
      <main className="relative mx-auto max-w-6xl px-6 py-12">
        {/* Header */}
        <header className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-card/60 px-3 py-1 text-xs text-muted-foreground font-mono-display">
              <span className="size-1.5 rounded-full bg-primary pulse-dot" />
              мониторинг работает • интервал 60с
            </div>
            <h1 className="mt-4 font-mono-display text-4xl md:text-5xl font-semibold tracking-tight">
              <span className="glow-text text-primary">site</span>_watcher
              <span className="text-muted-foreground">.</span>
            </h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">
              Отслеживание любых изменений HTML на указанных страницах с мгновенными
              уведомлениями в Telegram. Проверка раз в минуту, история событий, нулевая настройка.
            </p>
          </div>
          <AddSiteDialog defaultChatId={defaultChatId} />
        </header>

        {/* Stats */}
        <section className="mt-10 grid grid-cols-2 md:grid-cols-3 gap-3">
          <StatCard icon={<Activity className="size-4" />} label="активных" value={activeCount} />
          <StatCard icon={<Bell className="size-4" />} label="изменений" value={changesCount} accent="warning" />
          <StatCard
            icon={<Activity className="size-4" />}
            label="ошибок"
            value={errorCount}
            accent={errorCount > 0 ? "destructive" : "default"}
          />
        </section>

        {/* Telegram setup */}
        <Card className="mt-8 p-5 bg-card/60 backdrop-blur">
          <div className="flex items-center gap-2 mb-3">
            <Send className="size-4 text-primary" />
            <h2 className="font-mono-display font-medium">Telegram</h2>
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            Введите ваш Telegram chat_id — он будет подставляться по умолчанию для новых сайтов.
            Узнать: напишите боту <code className="text-primary">@userinfobot</code>.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="chat" className="text-xs">chat_id по умолчанию</Label>
              <Input
                id="chat"
                placeholder="123456789"
                value={defaultChatId}
                onChange={(e) => setDefaultChatId(e.target.value)}
                className="font-mono-display"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={saveChatId}>Сохранить</Button>
              <Button onClick={sendTest} disabled={testing} className="gap-1.5">
                <Send className="size-3.5" />
                {testing ? "Отправка…" : "Тест"}
              </Button>
            </div>
          </div>
        </Card>

        {/* Sites */}
        <section className="mt-10">
          <h2 className="font-mono-display text-lg font-medium mb-4">
            Отслеживаемые сайты
            <span className="text-muted-foreground"> ({sites.length})</span>
          </h2>
          {sites.length === 0 ? (
            <Card className="p-10 text-center bg-card/40 border-dashed">
              <p className="text-sm text-muted-foreground">
                Пока ничего не отслеживается. Нажмите{" "}
                <span className="text-primary font-mono-display">«Добавить сайт»</span>, чтобы начать.
              </p>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {sites.map((s) => (
                <SiteCard key={s.id} site={s} />
              ))}
            </div>
          )}
        </section>

        {/* History */}
        <section className="mt-12">
          <h2 className="font-mono-display text-lg font-medium mb-4">События</h2>
          <HistoryFeed entries={history} sites={sites} />
        </section>

        <footer className="mt-16 pt-8 border-t border-border/60 text-xs text-muted-foreground font-mono-display flex flex-wrap items-center justify-between gap-2">
          <span>powered by Lovable Cloud</span>
          <span>SHA-256 • interval 60s</span>
        </footer>
      </main>
    </div>
  );
};

function StatCard({
  icon,
  label,
  value,
  accent = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  accent?: "default" | "warning" | "destructive";
}) {
  const color =
    accent === "warning"
      ? "text-warning"
      : accent === "destructive"
        ? "text-destructive"
        : "text-primary";
  return (
    <Card className="p-4 bg-card/60 backdrop-blur">
      <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono-display">
        <span className={color}>{icon}</span>
        {label}
      </div>
      <div className={`mt-2 font-mono-display text-3xl font-semibold ${color}`}>{value}</div>
    </Card>
  );
}

export default Index;
