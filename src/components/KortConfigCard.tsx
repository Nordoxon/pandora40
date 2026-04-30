import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { RefreshCw, Send, Trash2, Trophy } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";

export interface KortSite {
  id: string;
  url: string;
  label: string | null;
  telegram_chat_id: string;
  current_hash: string | null;
  last_checked_at: string | null;
  last_status: string | null;
  is_active: boolean;
  monitor_type?: string;
}

interface Props {
  site: KortSite | null;
  defaultChatId: string;
}

export function KortConfigCard({ site, defaultChatId }: Props) {
  const [chatId, setChatId] = useState(site?.telegram_chat_id ?? defaultChatId ?? "");
  const [label, setLabel] = useState(site?.label ?? "");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  const isActive = site?.is_active ?? false;
  const isError = site?.last_status?.startsWith("error");
  const slotsCount = site?.current_hash?.startsWith("slots:")
    ? Number(site.current_hash.slice(6)) || 0
    : null;

  async function startMonitoring() {
    if (!chatId.trim()) {
      toast.error("Укажите Telegram chat_id");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("watched_sites").insert({
        url: "https://kort40.online",
        label: label.trim() || "kort40.online — свободные слоты",
        telegram_chat_id: chatId.trim(),
        monitor_type: "kort40",
      });
      if (error) throw error;
      toast.success("Мониторинг запущен. Первая проверка — в течение минуты.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setSaving(false);
    }
  }

  async function saveSettings() {
    if (!site) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("watched_sites")
        .update({
          telegram_chat_id: chatId.trim(),
          label: label.trim() || null,
        })
        .eq("id", site.id);
      if (error) throw error;
      toast.success("Сохранено");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(v: boolean) {
    if (!site) return;
    const { error } = await supabase
      .from("watched_sites")
      .update({ is_active: v })
      .eq("id", site.id);
    if (error) toast.error(error.message);
  }

  async function checkNow() {
    if (!site) return;
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

  async function stopAndRemove() {
    if (!site) return;
    if (!confirm("Остановить мониторинг и удалить настройку?")) return;
    const { error } = await supabase.from("watched_sites").delete().eq("id", site.id);
    if (error) toast.error(error.message);
    else toast.success("Мониторинг остановлен");
  }

  // ===== Setup state (no monitor yet) =====
  if (!site) {
    return (
      <Card className="p-6 bg-card/70 backdrop-blur border-clay/40">
        <div className="flex items-center gap-2 mb-1">
          <Trophy className="size-4 text-primary" />
          <h2 className="font-mono-display font-medium">Запустить мониторинг</h2>
        </div>
        <p className="text-xs text-muted-foreground mb-5">
          Учётные данные kort40 хранятся как секреты на сервере. Здесь укажите только Telegram chat_id —
          туда будут приходить уведомления о новых освободившихся кортах.
        </p>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="chat" className="text-xs">Telegram chat_id</Label>
            <Input
              id="chat"
              placeholder="123456789"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              className="font-mono-display"
            />
            <p className="text-xs text-muted-foreground">
              Узнать chat_id: напишите боту <code className="text-primary">@userinfobot</code> в Telegram.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="label" className="text-xs">Метка (опционально)</Label>
            <Input
              id="label"
              placeholder="например: Корты по будням"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <Button onClick={startMonitoring} disabled={saving} className="gap-2">
            <Trophy className="size-4" />
            {saving ? "Запуск…" : "Запустить мониторинг"}
          </Button>
        </div>
      </Card>
    );
  }

  // ===== Active monitor =====
  return (
    <Card className="p-6 bg-card/70 backdrop-blur border-clay/40">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block size-2 rounded-full ${
                !site.last_checked_at
                  ? "bg-muted-foreground"
                  : isError
                    ? "bg-destructive"
                    : "bg-primary"
              } ${isActive && !isError ? "pulse-dot" : ""}`}
            />
            <h2 className="font-mono-display font-medium">
              {site.label || "kort40.online"}
            </h2>
          </div>
          <a
            href="https://kort40.online"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground hover:text-primary mt-0.5 inline-block"
          >
            kort40.online
          </a>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground font-mono-display">
            {isActive ? "вкл" : "выкл"}
          </span>
          <Switch checked={isActive} onCheckedChange={toggleActive} />
        </div>
      </div>

      {/* Slot counter — hero number */}
      <div className="mt-6 court-lines rounded-lg p-6 text-center">
        <div className="text-[11px] uppercase tracking-widest text-clay-foreground/80 font-mono-display">
          свободных слотов сейчас
        </div>
        <div className="mt-1 font-mono-display text-6xl font-semibold text-primary glow-text leading-none">
          {slotsCount ?? "—"}
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground font-mono-display">
          горизонт 30 дней • проверка каждую минуту
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 text-xs">
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

      <div className="mt-5 space-y-3 border-t border-border/60 pt-5">
        <div className="space-y-1.5">
          <Label htmlFor="chat-edit" className="text-xs flex items-center gap-1.5">
            <Send className="size-3" /> Telegram chat_id
          </Label>
          <Input
            id="chat-edit"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            className="font-mono-display"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="label-edit" className="text-xs">Метка</Label>
          <Input
            id="label-edit"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <Button size="sm" onClick={saveSettings} disabled={saving}>
          {saving ? "Сохранение…" : "Сохранить"}
        </Button>
        <Button size="sm" variant="secondary" onClick={checkNow} disabled={checking} className="gap-1.5">
          <RefreshCw className={`size-3.5 ${checking ? "animate-spin" : ""}`} />
          Проверить сейчас
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={stopAndRemove}
          className="gap-1.5 text-muted-foreground hover:text-destructive ml-auto"
        >
          <Trash2 className="size-3.5" />
          Остановить
        </Button>
      </div>
    </Card>
  );
}