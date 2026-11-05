// A small LaTeX → MathML converter, so math renders with the browser's own MathML support and no
// library. It covers the common subset: fractions, roots, super/subscripts, Greek letters, big
// operators with limits, \text, \left…\right, and the usual relations and arrows. Anything it cannot
// parse is shown as the original source.

const SYMBOLS: Record<string, [tag: "mi" | "mo", value: string]> = {
  alpha: ["mi", "α"], beta: ["mi", "β"], gamma: ["mi", "γ"], delta: ["mi", "δ"], epsilon: ["mi", "ε"], varepsilon: ["mi", "ε"], zeta: ["mi", "ζ"], eta: ["mi", "η"],
  theta: ["mi", "θ"], vartheta: ["mi", "ϑ"], iota: ["mi", "ι"], kappa: ["mi", "κ"], lambda: ["mi", "λ"], mu: ["mi", "μ"], nu: ["mi", "ν"], xi: ["mi", "ξ"], pi: ["mi", "π"],
  rho: ["mi", "ρ"], sigma: ["mi", "σ"], tau: ["mi", "τ"], upsilon: ["mi", "υ"], phi: ["mi", "φ"], varphi: ["mi", "ϕ"], chi: ["mi", "χ"], psi: ["mi", "ψ"], omega: ["mi", "ω"],
  Gamma: ["mi", "Γ"], Delta: ["mi", "Δ"], Theta: ["mi", "Θ"], Lambda: ["mi", "Λ"], Xi: ["mi", "Ξ"], Pi: ["mi", "Π"], Sigma: ["mi", "Σ"], Phi: ["mi", "Φ"], Psi: ["mi", "Ψ"], Omega: ["mi", "Ω"],
  infty: ["mi", "∞"], partial: ["mi", "∂"], nabla: ["mi", "∇"], hbar: ["mi", "ℏ"], ell: ["mi", "ℓ"], emptyset: ["mi", "∅"], forall: ["mo", "∀"], exists: ["mo", "∃"],
  cdot: ["mo", "⋅"], times: ["mo", "×"], div: ["mo", "÷"], pm: ["mo", "±"], mp: ["mo", "∓"], ast: ["mo", "∗"], circ: ["mo", "∘"], bullet: ["mo", "•"],
  leq: ["mo", "≤"], le: ["mo", "≤"], geq: ["mo", "≥"], ge: ["mo", "≥"], neq: ["mo", "≠"], ne: ["mo", "≠"], approx: ["mo", "≈"], equiv: ["mo", "≡"], sim: ["mo", "∼"], propto: ["mo", "∝"], ll: ["mo", "≪"], gg: ["mo", "≫"],
  in: ["mo", "∈"], notin: ["mo", "∉"], subset: ["mo", "⊂"], subseteq: ["mo", "⊆"], supset: ["mo", "⊃"], cup: ["mo", "∪"], cap: ["mo", "∩"], setminus: ["mo", "∖"],
  to: ["mo", "→"], rightarrow: ["mo", "→"], leftarrow: ["mo", "←"], leftrightarrow: ["mo", "↔"], Rightarrow: ["mo", "⇒"], Leftarrow: ["mo", "⇐"], Leftrightarrow: ["mo", "⇔"], mapsto: ["mo", "↦"],
  land: ["mo", "∧"], lor: ["mo", "∨"], neg: ["mo", "¬"], ldots: ["mo", "…"], cdots: ["mo", "⋯"], dots: ["mo", "…"], vdots: ["mo", "⋮"], ddots: ["mo", "⋱"],
};
const BIG: Record<string, string> = { sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", oint: "∮", bigcup: "⋃", bigcap: "⋂", lim: "lim", max: "max", min: "min", sup: "sup", inf: "inf" };
const NAMED = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "exp", "det", "dim", "gcd", "arg", "deg", "ker", "Pr"]);
const OVER_LIMITS = new Set(["sum", "prod", "coprod", "bigcup", "bigcap", "lim", "max", "min", "sup", "inf"]);
const SPACES: Record<string, string> = { ",": "0.17em", ";": "0.28em", ":": "0.22em", " ": "0.28em", quad: "1em", qquad: "2em", "!": "-0.17em" };
const MAX_INPUT = 4000;
const MAX_DEPTH = 40;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

class Failure extends Error {}

type Token = { kind: "cmd" | "char"; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (/\s/.test(ch)) continue;
    if (ch === "\\") {
      const name = /^[A-Za-z]+/.exec(src.slice(i + 1))?.[0];
      if (name) { tokens.push({ kind: "cmd", value: name }); i += name.length; }
      else if (i + 1 < src.length) { tokens.push({ kind: "cmd", value: src[i + 1] }); i += 1; }
      continue;
    }
    tokens.push({ kind: "char", value: ch });
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly t: Token[]) {}

  private peek = () => this.t[this.pos];
  private isChar = (value: string) => this.peek()?.kind === "char" && this.peek()!.value === value;
  private expectChar(value: string) { if (!this.isChar(value)) throw new Failure(`expected ${value}`); this.pos += 1; }

  /** Parse until a closing `}` / `\right` / end, or `stop` returns true. */
  row(stop: () => boolean = () => false): string[] {
    if (++this.depth > MAX_DEPTH) throw new Failure("too deep");
    const out: string[] = [];
    while (this.pos < this.t.length && !stop()) {
      const token = this.peek();
      if (token.kind === "char" && token.value === "}") break;
      if (token.kind === "cmd" && (token.value === "right" || token.value === "end")) break;
      out.push(this.scripted());
    }
    this.depth -= 1;
    return out;
  }

  private group(): string {
    this.expectChar("{");
    const inner = this.row();
    this.expectChar("}");
    return inner.length === 1 ? inner[0] : `<mrow>${inner.join("")}</mrow>`;
  }

  /** One argument: a `{group}` or a single token. */
  private arg(): string {
    if (this.isChar("{")) return this.group();
    if (!this.peek()) throw new Failure("missing argument");
    return this.atom();
  }

  private scripted(): string {
    const start = this.peek();
    let base = this.atom();
    let sub: string | null = null;
    let sup: string | null = null;
    while (this.isChar("^") || this.isChar("_")) {
      const which = this.peek().value;
      this.pos += 1;
      const script = this.arg();
      if (which === "^") sup = script; else sub = script;
    }
    if (sub === null && sup === null) return base;
    const over = start?.kind === "cmd" && OVER_LIMITS.has(start.value);
    if (sub !== null && sup !== null) return `<${over ? "munderover" : "msubsup"}>${base}${sub}${sup}</${over ? "munderover" : "msubsup"}>`;
    if (sub !== null) return `<${over ? "munder" : "msub"}>${base}${sub}</${over ? "munder" : "msub"}>`;
    return `<${over ? "mover" : "msup"}>${base}${sup}</${over ? "mover" : "msup"}>`;
  }

  private atom(): string {
    const token = this.peek();
    if (!token) throw new Failure("unexpected end");
    this.pos += 1;
    if (token.kind === "char") {
      const v = token.value;
      if (v === "{") { this.pos -= 1; return this.group(); }
      if (/[0-9]/.test(v)) {
        let number = v;
        while (this.peek()?.kind === "char" && /[0-9.]/.test(this.peek()!.value)) number += this.t[this.pos++].value;
        return `<mn>${esc(number)}</mn>`;
      }
      if (/\p{L}/u.test(v)) return `<mi>${esc(v)}</mi>`;
      if (v === "^" || v === "_" || v === "}" || v === "&") throw new Failure(`unexpected ${v}`);
      return `<mo>${esc(v)}</mo>`;
    }
    const name = token.value;
    if (name === "frac" || name === "dfrac" || name === "tfrac") return `<mfrac>${this.arg()}${this.arg()}</mfrac>`;
    if (name === "binom") return `<mrow><mo>(</mo><mfrac linethickness="0">${this.arg()}${this.arg()}</mfrac><mo>)</mo></mrow>`;
    if (name === "sqrt") {
      if (this.isChar("[")) {
        this.pos += 1;
        const index = this.row(() => this.isChar("]"));
        this.expectChar("]");
        return `<mroot>${this.arg()}<mrow>${index.join("")}</mrow></mroot>`;
      }
      return `<msqrt>${this.arg()}</msqrt>`;
    }
    if (name === "text" || name === "mathrm" || name === "textrm" || name === "operatorname" || name === "mathbf" || name === "mathit") {
      if (!this.isChar("{")) throw new Failure("missing text");
      this.pos += 1;
      let text = "";
      let depth = 1;
      while (this.pos < this.t.length) {
        const part = this.t[this.pos++];
        if (part.kind === "char" && part.value === "{") depth += 1;
        if (part.kind === "char" && part.value === "}" && --depth === 0) break;
        text += part.kind === "cmd" ? "" : part.value;
      }
      const variant = name === "mathbf" ? ' mathvariant="bold"' : name === "mathit" ? ' mathvariant="italic"' : "";
      return name === "text" || name === "textrm" ? `<mtext>${esc(text)}</mtext>` : `<mi${variant || ' mathvariant="normal"'}>${esc(text)}</mi>`;
    }
    if (name === "mathbb" || name === "mathcal" || name === "mathfrak") return this.arg();
    if (name === "hat" || name === "bar" || name === "vec" || name === "tilde" || name === "dot" || name === "overline") {
      const mark = { hat: "^", bar: "¯", vec: "→", tilde: "~", dot: "˙", overline: "¯" }[name];
      return `<mover accent="true">${this.arg()}<mo>${mark}</mo></mover>`;
    }
    if (name === "underline") return `<munder>${this.arg()}<mo>_</mo></munder>`;
    if (name === "left") {
      const open = this.delimiter();
      const inner = this.row();
      if (this.peek()?.kind !== "cmd" || this.peek()!.value !== "right") throw new Failure("missing \\right");
      this.pos += 1;
      const close = this.delimiter();
      return `<mrow>${open ? `<mo>${esc(open)}</mo>` : ""}${inner.join("")}${close ? `<mo>${esc(close)}</mo>` : ""}</mrow>`;
    }
    if (name in SPACES) return `<mspace width="${SPACES[name]}"/>`;
    if (name in BIG) return `<mo${name === "int" || name === "iint" || name === "oint" ? "" : ' largeop="true"'}${OVER_LIMITS.has(name) ? ' movablelimits="true"' : ""}>${esc(BIG[name])}</mo>`;
    if (NAMED.has(name)) return `<mi mathvariant="normal">${name}</mi>`;
    const symbol = SYMBOLS[name];
    if (symbol) return `<${symbol[0]}>${symbol[1]}</${symbol[0]}>`;
    if ("{}%$#_&".includes(name)) return `<mo>${esc(name)}</mo>`;
    if (name === "\\") return `<mspace linebreak="newline"/>`;
    throw new Failure(`unknown command \\${name}`);
  }

  private delimiter(): string {
    const token = this.peek();
    if (!token) throw new Failure("missing delimiter");
    this.pos += 1;
    if (token.kind === "char") return token.value === "." ? "" : token.value;
    return ({ langle: "⟨", rangle: "⟩", lbrace: "{", rbrace: "}", lvert: "|", rvert: "|", "|": "‖", "{": "{", "}": "}" } as Record<string, string>)[token.value] ?? "";
  }

  parse(): string {
    const nodes = this.row();
    if (this.pos < this.t.length) throw new Failure("unbalanced input");
    return nodes.join("");
  }
}

/** MathML for a LaTeX fragment, or `null` when it cannot be parsed (callers then show the source). */
export function latexToMathML(source: string, display = false): string | null {
  const src = source.trim();
  if (!src || src.length > MAX_INPUT) return null;
  try {
    const body = new Parser(tokenize(src)).parse();
    return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${display ? "block" : "inline"}"><semantics><mrow>${body}</mrow><annotation encoding="application/x-tex">${esc(src)}</annotation></semantics></math>`;
  } catch (error) {
    if (error instanceof Failure) return null;
    throw error;
  }
}

/** Rendered math, or the escaped source in a muted code span when it does not parse. */
export function renderMath(source: string, display: boolean): string {
  return latexToMathML(source, display) ?? `<code class="md-math-error" title="Could not render this formula">${esc(display ? `$$${source}$$` : `$${source}$`)}</code>`;
}

/** Inline `$…$` / `\(…\)` spans. A dollar sign next to a digit or space stays text, so "$5 and $10" is untouched. */
export const INLINE_MATH = /\\\(([^\n]+?)\\\)|(?<![\\$\w])\$(?![\s$])([^$\n]*[^$\s\n\\])\$(?![\d$\w])/g;
