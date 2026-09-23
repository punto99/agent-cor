"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import styles from "./BoardDialog.module.css";

export function ExpandableDescription({ html }: { html: string }) {
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    setExpanded(false);
    const element = content.current;
    if (!element) return;
    const measure = () => setLong(element.scrollHeight > 400);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [html]);

  return <div ref={section}>
    <div id={id} className={long && !expanded ? styles.descriptionCollapsed : undefined} onFocusCapture={() => setExpanded(true)}>
      <div ref={content} className={`${styles.richText} whitespace-pre-wrap`} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
    {long && <button type="button" className={styles.descriptionToggle} aria-expanded={expanded} aria-controls={id} onClick={() => {
      if (expanded) {
        const scroll = section.current?.closest<HTMLElement>("[data-board-scroll]");
        if (scroll && section.current) {
          const offset = section.current.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 80;
          if (offset < 0) scroll.scrollTop += offset;
        }
      }
      setExpanded(value => !value);
    }}>{expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}{expanded ? "Mostrar menos" : "Mostrar más"}</button>}
  </div>;
}
