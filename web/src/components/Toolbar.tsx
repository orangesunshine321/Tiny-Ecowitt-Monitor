import type { HTMLAttributes, ReactNode } from 'react';
import './Toolbar.css';

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

/** A row of toolbar groups, right-aligned. Pass it as `PageHeader`'s `toolbar`. */
export function Toolbar({ className, children, ...rest }: ToolbarProps) {
  return (
    <div role="toolbar" {...rest} className={`ui-toolbar ${className ?? ''}`}>
      {children}
    </div>
  );
}

export interface ToolbarGroupProps extends HTMLAttributes<HTMLDivElement> {
  /** accessible name for the group, e.g. "View options" */
  label?: string;
  children?: ReactNode;
}

/**
 * A glass capsule holding related controls (IconButtons, Buttons, a SegmentedControl). Items inside lose their own
 * bezel, as AppKit does for grouped toolbar items.
 */
export function ToolbarGroup({ label, className, children, ...rest }: ToolbarGroupProps) {
  return (
    <div role="group" aria-label={label} {...rest} className={`ui-toolbar-group glass ${className ?? ''}`}>
      {children}
    </div>
  );
}

/** Hairline divider between items of one ToolbarGroup. */
export function ToolbarSeparator() {
  return <span className="ui-toolbar-separator" aria-hidden="true" />;
}
