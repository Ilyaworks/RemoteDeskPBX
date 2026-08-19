// ─────────────────────────────────────────────────────────────────────────
// Тема onlinePBX — единый источник токенов для Client и Employee.
// Токены сняты с onlinepbx.ru (палитра, шрифт, скругления).
// Импортируется обоими приложениями; логика UI не зависит от этих значений.
// ─────────────────────────────────────────────────────────────────────────

import type { CSSProperties } from 'react';

export const colors = {
  // Бренд
  green: '#00BB20',        // главное действие (CTA)
  greenHover: '#06A81F',
  greenDark: '#049A1B',
  navy: '#262C44',         // тёмный бренд (шапки, заголовки)
  navyHover: '#1B2036',
  indigo: '#4E4963',       // приглушённый вторичный

  // Текст
  heading: '#2F2F36',
  text: '#3A3A42',
  muted: '#8A8A94',

  // Поверхности
  appBg: '#FAFAFA',
  card: '#FFFFFF',
  subtle: '#F5F6FA',
  border: '#E6E7EE',

  // Тинты-подложки
  greenTint: '#ECF8EE',
  lavender: '#F0F1FF',
  peach: '#FFF5F1',

  // Статусы
  success: '#049A1B',
  danger: '#E5484D',
  dangerHover: '#D33B40',
  dangerTint: '#FDECEC',
  warning: '#E8A800',

  white: '#FFFFFF',
} as const;

export const font =
  "'Montserrat', 'Segoe UI', Roboto, Arial, sans-serif";
export const mono =
  "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace";

export const radius = { sm: 6, md: 8, lg: 12, xl: 16 } as const;

// Плоский индикатор качества связи (без псевдообъёма) — ключ → цвет + подпись
export const quality: Record<string, { color: string; label: string }> = {
  good: { color: colors.green, label: 'Отличное' },
  ok: { color: colors.warning, label: 'Среднее' },
  bad: { color: colors.danger, label: 'Плохое' },
};

export const shadow = {
  card: '0 1px 3px rgba(38,44,68,0.06), 0 1px 2px rgba(38,44,68,0.04)',
  elevated: '0 8px 28px rgba(38,44,68,0.14)',
} as const;

// ── Готовые style-объекты (spread в inline-стили компонентов) ──────────────

export const s = {
  page: {
    fontFamily: font,
    color: colors.text,
    background: colors.appBg,
  } as CSSProperties,

  h1: {
    fontFamily: font,
    color: colors.heading,
    fontSize: 26,
    fontWeight: 700,
    letterSpacing: '-0.01em',
    margin: 0,
  } as CSSProperties,

  subtitle: {
    color: colors.muted,
    fontSize: 14,
    margin: '8px 0 0',
  } as CSSProperties,

  card: {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: radius.lg,
    boxShadow: shadow.card,
  } as CSSProperties,

  btnPrimary: {
    background: colors.green,
    color: colors.white,
    border: 'none',
    borderRadius: radius.md,
    fontFamily: font,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background .15s ease',
  } as CSSProperties,

  btnDanger: {
    background: colors.danger,
    color: colors.white,
    border: 'none',
    borderRadius: radius.md,
    fontFamily: font,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background .15s ease',
  } as CSSProperties,

  btnGhost: {
    background: 'transparent',
    color: colors.indigo,
    border: `1px solid ${colors.border}`,
    borderRadius: radius.md,
    fontFamily: font,
    fontWeight: 600,
    cursor: 'pointer',
  } as CSSProperties,

  input: {
    fontFamily: font,
    fontSize: 15,
    color: colors.heading,
    background: colors.white,
    border: `1px solid ${colors.border}`,
    borderRadius: radius.md,
    outline: 'none',
    boxSizing: 'border-box',
  } as CSSProperties,

  bannerError: {
    color: colors.danger,
    background: colors.dangerTint,
    border: `1px solid ${colors.danger}22`,
    padding: '10px 14px',
    borderRadius: radius.md,
    fontSize: 13,
  } as CSSProperties,

  bannerInfo: {
    color: colors.indigo,
    background: colors.lavender,
    border: `1px solid ${colors.indigo}1A`,
    padding: '12px 14px',
    borderRadius: radius.md,
    fontSize: 13,
  } as CSSProperties,

  bannerSuccess: {
    color: colors.success,
    background: colors.greenTint,
    padding: '10px 14px',
    borderRadius: radius.md,
    fontSize: 13,
  } as CSSProperties,

  log: {
    background: colors.navy,
    color: '#8CE99A',
    padding: '10px 12px',
    borderRadius: radius.md,
    fontSize: 11,
    fontFamily: mono,
    lineHeight: 1.55,
    overflow: 'auto',
    border: `1px solid ${colors.navyHover}`,
  } as CSSProperties,
} as const;
