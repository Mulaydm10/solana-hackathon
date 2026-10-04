"use client";
// The Atelier interaction layer (from the Claude Design file "Fiducia Atelier v3"): drafting cursor, hero loupe,
// magnetic buttons, card tilt, smoothed wheel scroll, scroll progress, and the ink sheet that covers page changes.
// Fine pointers only for the pointer effects; prefers-reduced-motion turns every effect off.
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

const SHEETS: [string, string][] = [
  ["/", "Catalogue"], ["/listing", "Listing"], ["/deal", "Deal"], ["/sell", "Sell"], ["/hire", "Hire a team"],
  ["/missions", "Missions"], ["/demand", "Demand"], ["/dashboard", "Dashboard"], ["/proof", "Proof"],
];
const EASE = "cubic-bezier(.16,1,.3,1)";
const HOVERABLE = "a, button, select, input, label, summary, [role='button']";

export function sheetOf(path: string): { name: string; n: string } {
  const i = SHEETS.findIndex(([p], k) => (k === 0 ? path === "/" : path === p || path.startsWith(`${p}/`)));
  const k = i < 0 ? 0 : i;
  const [, name] = SHEETS[k] ?? ["/", "Catalogue"];
  return { name, n: `Sheet ${String(k + 1).padStart(2, "0")} / ${String(SHEETS.length).padStart(2, "0")}` };
}

function scrollableAncestor(el: Element | null, dy: number): boolean {
  for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (/(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight) {
      if ((dy < 0 && e.scrollTop > 0) || (dy > 0 && e.scrollTop + e.clientHeight < e.scrollHeight - 1)) return true;
    }
  }
  return false;
}

export function Motion() {
  const router = useRouter();
  const pathname = usePathname();
  const ink = useRef<HTMLDivElement>(null);
  const big = useRef<HTMLSpanElement>(null);
  const small = useRef<HTMLSpanElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const dot = useRef<HTMLDivElement>(null);
  const hLine = useRef<HTMLDivElement>(null);
  const vLine = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const pending = useRef<string | null>(null);
  const first = useRef(true);

  useEffect(() => {
    const root = document.documentElement;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const fine = matchMedia("(hover: hover) and (pointer: fine)");
    const calm = () => reduced.matches;
    const cur = { x: innerWidth / 2, y: innerHeight / 2, tx: innerWidth / 2, ty: innerHeight / 2, s: 1, ts: 1 };
    const loupe = { x: 0, y: 0, tx: 0, ty: 0, r: 0, tr: 0, inside: false };
    let sy = scrollY, expected = scrollY, smoothing = false, raf = 0, pressed: HTMLElement | null = null, magnet: HTMLElement | null = null, tilted: HTMLElement | null = null;
    const hero = () => document.querySelector<HTMLElement>("[data-loupe]");
    const bar = () => document.querySelector<HTMLElement>(".scroll-progress");

    const sync = () => {
      const on = fine.matches && !calm();
      root.dataset.cursor = on ? "on" : "off";
      root.dataset.smooth = calm() ? "off" : "on";
      if (wrap.current) wrap.current.style.display = on ? "block" : "none";
    };
    sync();

    const onScroll = () => {
      if (!smoothing) sy = scrollY;
      const b = bar(), max = root.scrollHeight - innerHeight;
      if (b) b.style.width = `${max > 0 ? Math.min(100, (scrollY / max) * 100) : 0}%`;
      const h = hero();
      if (h) h.style.setProperty("--hp", calm() ? "0" : Math.max(0, Math.min(1, -h.getBoundingClientRect().top / (innerHeight * 0.85))).toFixed(3));
    };

    const reset = (el: HTMLElement | null) => {
      if (!el) return;
      el.style.transform = "";
      el.style.removeProperty("--mx");
      el.style.removeProperty("--my");
    };
    const onMove = (e: MouseEvent) => {
      cur.tx = e.clientX; cur.ty = e.clientY;
      const t = e.target instanceof Element ? e.target : null;
      cur.ts = t?.closest(HOVERABLE) ? 1.9 : 1;
      if (wrap.current) wrap.current.style.opacity = "1";
      const h = hero();
      if (h && !calm() && fine.matches) {
        const r = h.getBoundingClientRect();
        loupe.inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        loupe.tx = e.clientX - r.left; loupe.ty = e.clientY - r.top;
        loupe.tr = loupe.inside ? 150 : 0;
        root.dataset.inHero = loupe.inside ? "1" : "0";
      }
      if (calm() || !fine.matches) return;
      const m = t?.closest<HTMLElement>("[data-magnet]") ?? null;
      if (m !== magnet) { reset(magnet); magnet = m; }
      if (m) {
        const r = m.getBoundingClientRect();
        m.style.transform = `translate(${((e.clientX - r.left - r.width / 2) * 0.28).toFixed(1)}px,${((e.clientY - r.top - r.height / 2) * 0.4).toFixed(1)}px)`;
      }
      const c = t?.closest<HTMLElement>("[data-tilt]") ?? null;
      if (c !== tilted) { reset(tilted); tilted = c; }
      if (c) {
        const r = c.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
        c.style.transform = `perspective(800px) rotateX(${(-y * 10).toFixed(2)}deg) rotateY(${(x * 12).toFixed(2)}deg) translateZ(8px)`;
        c.style.setProperty("--mx", `${((x + 0.5) * 100).toFixed(1)}%`);
        c.style.setProperty("--my", `${((y + 0.5) * 100).toFixed(1)}%`);
      }
    };
    const onOut = (e: MouseEvent) => {
      if (e.relatedTarget) return;
      if (wrap.current) wrap.current.style.opacity = "0";
      loupe.tr = 0; root.dataset.inHero = "0";
      reset(magnet); reset(tilted); magnet = tilted = null;
    };

    const onWheel = (e: WheelEvent) => {
      if (calm() || e.ctrlKey || e.defaultPrevented) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest("select, textarea, [role='dialog'], .main-nav") || scrollableAncestor(t, e.deltaY)) return;
      e.preventDefault();
      if (!smoothing) sy = scrollY;
      sy = Math.max(0, Math.min(root.scrollHeight - innerHeight, sy + e.deltaY * (e.deltaMode === 1 ? 40 : 1)));
      expected = scrollY; smoothing = true;
    };
    const stopSmooth = () => { smoothing = false; sy = scrollY; };

    const tick = () => {
      cur.x += (cur.tx - cur.x) * 0.2; cur.y += (cur.ty - cur.y) * 0.2; cur.s += (cur.ts - cur.s) * 0.2;
      if (ring.current) {
        ring.current.style.transform = `translate(${cur.x}px,${cur.y}px) translate(-50%,-50%) scale(${cur.s.toFixed(3)})`;
        dot.current!.style.transform = `translate(${cur.tx}px,${cur.ty}px) translate(-50%,-50%)`;
        hLine.current!.style.transform = `translateY(${cur.ty}px)`;
        vLine.current!.style.transform = `translateX(${cur.tx}px)`;
        label.current!.style.transform = `translate(${cur.tx + 16}px,${cur.ty + 16}px)`;
        label.current!.textContent = `X ${String(Math.round(cur.tx)).padStart(4, "0")}  Y ${String(Math.round(cur.ty + scrollY)).padStart(4, "0")}`;
      }
      const h = hero();
      if (h) {
        if (!fine.matches && !calm()) {
          const t = performance.now() / 1000, r = h.getBoundingClientRect();
          loupe.tx = r.width * (0.5 + 0.28 * Math.sin(t * 0.55)); loupe.ty = r.height * (0.5 + 0.22 * Math.sin(t * 0.9 + 1));
          loupe.tr = 105;
        }
        if (loupe.r < 0.5 && loupe.tr > 0) { loupe.x = loupe.tx; loupe.y = loupe.ty; }
        loupe.x += (loupe.tx - loupe.x) * 0.18; loupe.y += (loupe.ty - loupe.y) * 0.18; loupe.r += (loupe.tr - loupe.r) * 0.14;
        h.style.setProperty("--lx", `${loupe.x.toFixed(1)}px`);
        h.style.setProperty("--ly", `${loupe.y.toFixed(1)}px`);
        h.style.setProperty("--lr", `${loupe.r.toFixed(1)}px`);
        h.style.setProperty("--lo", Math.min(1, loupe.r / 60).toFixed(3));
      }
      if (smoothing) {
        if (Math.abs(scrollY - expected) > 2) smoothing = false;
        else {
          const before = scrollY, y = before + (sy - before) * 0.12;
          if (Math.abs(sy - y) < 0.5) { window.scrollTo(0, sy); smoothing = false; }
          else { window.scrollTo(0, y); if (Math.abs(scrollY - before) < 0.1) { window.scrollTo(0, sy); smoothing = false; } }
          expected = scrollY;
        }
      }
      raf = requestAnimationFrame(tick);
    };

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname) {
        const target = url.hash && url.search === location.search ? document.getElementById(decodeURIComponent(url.hash.slice(1))) : null;
        if (target && !calm()) {
          e.preventDefault();
          history.pushState(null, "", url.hash);
          sy = Math.max(0, Math.min(root.scrollHeight - innerHeight, target.getBoundingClientRect().top + scrollY - parseFloat(getComputedStyle(target).scrollMarginTop || "0")));
          expected = scrollY; smoothing = true;
        }
        return;
      }
      if (calm() || !ink.current) return;
      e.preventDefault();
      e.stopPropagation();
      const sheet = sheetOf(url.pathname);
      big.current!.textContent = sheet.name; small.current!.textContent = sheet.n;
      const r = Math.hypot(Math.max(e.clientX, innerWidth - e.clientX), Math.max(e.clientY, innerHeight - e.clientY)) + 40;
      const dest = url.pathname + url.search + url.hash;
      pending.current = url.pathname;
      const anim = ink.current.animate(
        [{ clipPath: `circle(0px at ${e.clientX}px ${e.clientY}px)` }, { clipPath: `circle(${r}px at ${e.clientX}px ${e.clientY}px)` }],
        { duration: 620, easing: "cubic-bezier(.7,0,.2,1)", fill: "forwards" },
      );
      anim.onfinish = () => {
        stopSmooth();
        router.push(dest);
        setTimeout(() => { if (pending.current) { pending.current = null; inkOut(); } }, 4000);
      };
    };
    const onKey = () => stopSmooth();
    const onDown = (e: PointerEvent) => {
      stopSmooth();
      if (calm() || e.button !== 0) return;
      pressed = e.target instanceof Element ? e.target.closest<HTMLElement>("button:not(:disabled), .btn") : null;
      pressed?.setAttribute("data-pressed", "");
    };
    const onUp = () => { pressed?.removeAttribute("data-pressed"); pressed = null; };

    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseout", onOut);
    addEventListener("wheel", onWheel, { passive: false });
    addEventListener("keydown", onKey);
    addEventListener("pointerdown", onDown, true);
    addEventListener("pointerup", onUp, true);
    addEventListener("pointercancel", onUp, true);
    addEventListener("touchstart", stopSmooth, { passive: true });
    addEventListener("click", onClick, true);
    reduced.addEventListener("change", sync);
    fine.addEventListener("change", sync);
    onScroll();
    raf = requestAnimationFrame(tick);

    if (root.dataset.intro === "1") {
      try { sessionStorage.setItem("fiducia-intro", "1"); } catch {}
      let n = 0;
      const id = setInterval(() => {
        n = Math.min(100, n + 4);
        if (small.current) small.current.textContent = `Drawing the sheet · ${String(n).padStart(3, "0")}`;
        if (n >= 100) { clearInterval(id); setTimeout(inkOut, 120); }
      }, 36);
    }
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("scroll", onScroll);
      removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseout", onOut);
      removeEventListener("wheel", onWheel);
      removeEventListener("keydown", onKey);
      removeEventListener("pointerdown", onDown, true);
      removeEventListener("pointerup", onUp, true);
      removeEventListener("pointercancel", onUp, true);
      removeEventListener("touchstart", stopSmooth);
      removeEventListener("click", onClick, true);
      reduced.removeEventListener("change", sync);
      fine.removeEventListener("change", sync);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function inkOut() {
    const el = ink.current;
    if (!el) return;
    el.getAnimations().forEach((a) => a.cancel());
    el.style.clipPath = "inset(0 0 0 0)";
    const anim = el.animate([{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(0 0 100% 0)" }], { duration: 780, easing: EASE, fill: "forwards" });
    anim.onfinish = () => { el.style.clipPath = ""; };
  }

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (pending.current) {
      pending.current = null;
      window.scrollTo(0, 0);
      const id = setTimeout(inkOut, 220);
      return () => clearTimeout(id);
    }
  }, [pathname]);

  const intro = sheetOf("/");
  return (
    <>
      <div ref={ink} className="ink-sheet" aria-hidden>
        <span className="ink-mark"><span className="brand-mark">f</span></span>
        <span ref={big} className="ink-big">Fiducia</span>
        <span ref={small} className="ink-small">Drawing the sheet · {intro.n}</span>
      </div>
      <div ref={wrap} className="cursor" aria-hidden style={{ display: "none" }}>
        <div ref={hLine} className="cursor-h" />
        <div ref={vLine} className="cursor-v" />
        <div ref={ring} className="cursor-ring" />
        <div ref={dot} className="cursor-dot" />
        <span ref={label} className="cursor-label" />
      </div>
    </>
  );
}
