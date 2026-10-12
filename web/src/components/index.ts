/**
 * pve1-dash component library (DESIGN §4). Import from here:
 *
 *   import { Card, CardGrid, RingGauge, StatusBadge, toneOf } from '../components';
 *
 * Materials: glass (GlassPanel, Toolbar groups, Sheet, Popover, Toast) is for chrome only; page content sits on Card
 * (the content material). Colours mean status (see status.ts) or chart series (SERIES_COLORS); nothing else.
 */
export { GlassPanel, type GlassPanelProps, type GlassVariant } from './GlassPanel';
export { Card, CardGrid, type CardProps, type CardGridProps } from './Card';
export { Toolbar, ToolbarGroup, ToolbarSeparator, type ToolbarProps, type ToolbarGroupProps } from './Toolbar';
export { SegmentedControl, type SegmentedControlProps, type SegmentOption } from './SegmentedControl';
export { Toggle, type ToggleProps } from './Toggle';
export { Button, type ButtonProps, type ButtonVariant, type ButtonTint } from './Button';
export { IconButton, type IconButtonProps } from './IconButton';
export { StatusBadge, type StatusBadgeProps } from './StatusBadge';
export { StatusDot, type StatusDotProps } from './StatusDot';
export { StatusIcon, type StatusIconProps } from './StatusIcon';
export {
  toneOf,
  severityTone,
  severityColor,
  TONE_COLOR,
  TONE_RANK,
  DEFAULT_THRESHOLDS,
  type Tone,
  type StatusInfo,
  type Thresholds,
} from './status';
export { RingGauge, type RingGaugeProps } from './RingGauge';
export { Meter, type MeterProps } from './Meter';
export { Sparkline, type SparklineProps } from './Sparkline';
export { TimeSeriesChart, SERIES_COLORS, type TimeSeriesChartProps, type ChartSeries } from './TimeSeriesChart';
export { ListGroup, ListRow, type ListGroupProps, type ListRowProps } from './ListGroup';
export { Table, type TableProps, type TableColumn } from './Table';
export { Sheet, type SheetProps } from './Sheet';
export { Popover, type PopoverProps, type PopoverPlacement } from './Popover';
export { Toast, type ToastProps } from './Toast';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { Skeleton, PageSkeleton, type SkeletonProps } from './Skeleton';
export { TagChip, type TagChipProps } from './TagChip';
export { AppIcon, iconUrl, monogram, DASHBOARD_ICONS_BASE, type AppIconProps } from './AppIcon';
export { OsIcon, osSlug, type OsIconProps } from './OsIcon';
export { RelativeTime, type RelativeTimeProps } from './RelativeTime';
export { Bytes, Percent, Rate, Duration } from './Formatters';
export { Portal } from './Portal';
export { colorFor, hashString } from './colors';
export { niceTicks, timeTicks, nearestIndex } from './chartScale';
// PageHeader, Spotlight and the install hint live with the shell (they talk to the chrome) but are part of the toolkit:
export { PageHeader, type PageHeaderProps } from '../shell/PageHeader';
export { Spotlight, openSpotlight } from '../shell/Spotlight';
export { AddToHomeScreenHint, useNeedsHomeScreenInstall, type AddToHomeScreenHintProps } from '../shell/AddToHomeScreenHint';
