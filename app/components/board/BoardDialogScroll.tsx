"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./BoardDialog.module.css";

export function BoardDialogScroll({ title, children }: { title: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [showTitle, setShowTitle] = useState(false);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      const heading = element.querySelector<HTMLElement>("[data-board-title]");
      setShowTitle(Boolean(heading && heading.getBoundingClientRect().bottom <= element.getBoundingClientRect().top));
    };
    const resize = new ResizeObserver(measure);
    const observeTitle = () => {
      resize.disconnect();
      resize.observe(element);
      const heading = element.querySelector<HTMLElement>("[data-board-title]");
      if (heading) resize.observe(heading);
      measure();
    };
    const mutations = new MutationObserver(observeTitle);
    mutations.observe(element, { childList: true, subtree: true });
    element.addEventListener("scroll", measure, { passive: true });
    observeTitle();
    return () => { resize.disconnect(); mutations.disconnect(); element.removeEventListener("scroll", measure); };
  }, [title]);

  return <div ref={root} data-board-scroll className="min-h-0 min-w-0 overflow-y-auto overscroll-contain">
    <div className={styles.stickyTitleAnchor} aria-hidden="true">
      <div className={`${styles.stickyTitle} ${showTitle ? styles.stickyTitleVisible : ""}`}>{title}</div>
    </div>
    {children}
  </div>;
}
