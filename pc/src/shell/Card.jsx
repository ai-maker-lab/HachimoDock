/**
 * [Input] title/subtitle/actions/children props plus an opt-in Collapsible with summary.
 * [Output] Unified section card. The frame is RegionCard: a label above a gray functional surface.
 * [Pos] component node in pc/src/shell
 * [Sync] If this file changes, update `pc/src/shell/.folder.md`.
 */

import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import RegionCard from "./RegionCard.jsx";

export default function Card({ id, title, subtitle, actions, children }) {
  return (
    <RegionCard id={id} title={title} subtitle={subtitle} actions={actions} tabIndex={id ? -1 : undefined}>
      {children}
    </RegionCard>
  );
}

function CardCollapsible({ title, summary, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className={open ? "card card--collapsible region-card is-open" : "card card--collapsible region-card"}
    >
      <button
        type="button"
        className="card__header card__header--toggle region-card__header"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <div className="card__title-block">
          <h2 className="card__title">{title}</h2>
          {!open && summary && <p className="card__subtitle">{summary}</p>}
        </div>
        <ChevronDown
          size={16}
          className={open ? "card__chevron is-open" : "card__chevron"}
          aria-hidden="true"
        />
      </button>
      <div
        className="card__body region-card__body"
        inert={open ? undefined : ""}
        aria-hidden={open ? undefined : true}
      >
        <div className="card__collapse">{children}</div>
      </div>
    </section>
  );
}

Card.Collapsible = CardCollapsible;
