/**
 * [Input] Summary label and the content revealed on demand.
 * [Output] A rounded, light-gray disclosure used for “如何使用” and other guidance.
 * [Pos] Shared shell primitive in pc/src/shell.
 */

import React from "react";

export default function DisclosurePanel({ summary, children, className = "", ...props }) {
  const classes = className ? `disclosure-panel ${className}` : "disclosure-panel";
  return (
    <details className={classes} {...props}>
      <summary>{summary}</summary>
      <div className="disclosure-panel__body">{children}</div>
    </details>
  );
}
