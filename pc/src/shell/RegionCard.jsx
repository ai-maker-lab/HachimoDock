/**
 * [Input] Optional title, subtitle, actions, and the controls that belong together.
 * [Output] A labeled functional region: the page stays white, and the controls sit in one gray rounded surface.
 * [Pos] Shared shell primitive in pc/src/shell. Card delegates its frame here.
 */
import React from "react";

export default function RegionCard({ id, title, subtitle, actions, children, className = "", tabIndex }) {
  const showHeader = title || subtitle || actions;
  const classes = ["region-card", "card", className].filter(Boolean).join(" ");
  return (
    <section className={classes} id={id} tabIndex={tabIndex}>
      {showHeader && (
        <header className="region-card__header card__header">
          <div className="card__title-block region-card__title-block">
            {title && <h2 className="region-card__title card__title">{title}</h2>}
            {subtitle && <p className="region-card__subtitle card__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card__actions region-card__actions">{actions}</div>}
        </header>
      )}
      <div className="region-card__body card__body">{children}</div>
    </section>
  );
}
