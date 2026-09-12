// SPDX-License-Identifier: Apache-2.0
//! Lossless S-expression reader/writer for KiCad files.
//!
//! Guarantees (see docs/engine-architecture.md invariants I1-I5):
//! - `dumps(&parse(x)?) == x` byte-for-byte for any input that parses.
//! - Unknown nodes are preserved verbatim; the parser has no notion of KiCad
//!   semantics.
//! - No native recursion: parsing and serialisation use explicit stacks.
//! - Hard limits (input size, nesting depth, child count) return structured
//!   errors instead of panicking.
//! - A single quoting function (`quote`) and a single unquoting function
//!   (`unquote`) exist in the whole engine.

use std::fmt;

/// Hard limits applied while parsing. Exceeding any of them yields
/// [`ErrorKind::LimitExceeded`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Maximum input size in bytes.
    pub max_bytes: usize,
    /// Maximum nesting depth of lists (root list is depth 1).
    pub max_depth: usize,
    /// Maximum number of direct children of a single list.
    pub max_children: usize,
    /// Maximum length of a single atom (quoted or bare), in bytes.
    pub max_atom_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_bytes: 256 * 1024 * 1024,
            max_depth: 512,
            max_children: 4_000_000,
            max_atom_bytes: 1024 * 1024,
        }
    }
}

/// Byte position in the input, plus 1-based line/column for messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Pos {
    pub offset: usize,
    pub line: usize,
    pub col: usize,
}

impl fmt::Display for Pos {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{} (byte {})", self.line, self.col, self.offset)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorKind {
    /// Input exceeded a configured limit.
    LimitExceeded { what: &'static str, limit: usize },
    /// A `)` with no matching `(`.
    UnexpectedClose,
    /// Input ended inside an open list.
    UnexpectedEof { open_lists: usize },
    /// Input ended inside a quoted string.
    UnterminatedString,
    /// Bytes other than whitespace after the root list.
    TrailingGarbage,
    /// Input contained no list at all.
    Empty,
    /// The root element is a bare atom, not a list.
    RootNotList,
    /// Input is not valid UTF-8.
    InvalidUtf8,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{kind:?} at {pos}")]
pub struct Error {
    pub kind: ErrorKind,
    pub pos: Pos,
}

pub type Result<T> = std::result::Result<T, Error>;

/// A leaf token. `raw` is the exact source text including surrounding quotes
/// and escape sequences, so serialisation is lossless.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Atom {
    pub raw: String,
}

impl Atom {
    /// Build an atom from a decoded value. Values that need quoting are quoted
    /// with [`quote`]; simple tokens are emitted bare.
    pub fn new(value: &str) -> Atom {
        if needs_quotes(value) {
            Atom { raw: quote(value) }
        } else {
            Atom {
                raw: value.to_string(),
            }
        }
    }

    /// Build an atom that is always quoted (KiCad quotes all string fields).
    pub fn quoted(value: &str) -> Atom {
        Atom { raw: quote(value) }
    }

    /// Build a bare (unquoted) atom. The caller guarantees the token is valid.
    pub fn bare(token: &str) -> Atom {
        debug_assert!(
            !needs_quotes(token),
            "bare atom would need quotes: {token:?}"
        );
        Atom {
            raw: token.to_string(),
        }
    }

    pub fn is_quoted(&self) -> bool {
        self.raw.starts_with('"')
    }

    /// Decoded value (quotes removed, escapes resolved).
    pub fn value(&self) -> String {
        if self.is_quoted() {
            unquote(&self.raw)
        } else {
            self.raw.clone()
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        self.value().parse().ok()
    }

    pub fn as_f64(&self) -> Option<f64> {
        self.value().parse().ok()
    }
}

/// A parenthesised list. `ws[i]` is the whitespace that precedes `children[i]`
/// (`ws[0]` is the whitespace right after `(`); `ws[children.len()]` is the
/// whitespace before `)`. Invariant: `ws.len() == children.len() + 1`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct List {
    pub children: Vec<Node>,
    pub ws: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    Atom(Atom),
    List(List),
}

/// A whole file: optional leading/trailing whitespace around the root list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Document {
    pub leading_ws: String,
    pub root: List,
    pub trailing_ws: String,
}

impl List {
    pub fn new() -> List {
        List {
            children: Vec::new(),
            ws: vec![String::new()],
        }
    }

    /// Build a list from children with single-space separation (compact form).
    pub fn compact(children: Vec<Node>) -> List {
        let n = children.len();
        let mut ws = Vec::with_capacity(n + 1);
        for i in 0..=n {
            ws.push(if i == 0 || i == n {
                String::new()
            } else {
                " ".to_string()
            });
        }
        List { children, ws }
    }

    /// First atom's decoded value (the list "name"), if any.
    pub fn name(&self) -> Option<String> {
        match self.children.first() {
            Some(Node::Atom(a)) => Some(a.value()),
            _ => None,
        }
    }

    pub fn is_named(&self, name: &str) -> bool {
        matches!(self.children.first(), Some(Node::Atom(a)) if !a.is_quoted() && a.raw == name)
    }

    /// Child lists (skipping atoms), in order.
    pub fn lists(&self) -> impl Iterator<Item = &List> {
        self.children.iter().filter_map(|c| match c {
            Node::List(l) => Some(l),
            _ => None,
        })
    }

    pub fn lists_mut(&mut self) -> impl Iterator<Item = &mut List> {
        self.children.iter_mut().filter_map(|c| match c {
            Node::List(l) => Some(l),
            _ => None,
        })
    }

    /// First child list named `name`.
    pub fn find(&self, name: &str) -> Option<&List> {
        self.lists().find(|l| l.is_named(name))
    }

    pub fn find_mut(&mut self, name: &str) -> Option<&mut List> {
        self.lists_mut().find(|l| l.is_named(name))
    }

    pub fn find_all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a List> + 'a {
        self.lists().filter(move |l| l.is_named(name))
    }

    /// Index of the first child list named `name`.
    pub fn position(&self, name: &str) -> Option<usize> {
        self.children
            .iter()
            .position(|c| matches!(c, Node::List(l) if l.is_named(name)))
    }

    /// Atom children after the name, decoded. Convenience for `(at 1 2 90)`.
    pub fn args(&self) -> Vec<String> {
        self.children
            .iter()
            .skip(1)
            .filter_map(|c| match c {
                Node::Atom(a) => Some(a.value()),
                _ => None,
            })
            .collect()
    }

    /// Nth atom argument after the name (0-based), decoded.
    pub fn arg(&self, n: usize) -> Option<String> {
        self.children
            .iter()
            .skip(1)
            .filter_map(|c| match c {
                Node::Atom(a) => Some(a),
                _ => None,
            })
            .nth(n)
            .map(|a| a.value())
    }

    pub fn arg_f64(&self, n: usize) -> Option<f64> {
        self.arg(n).and_then(|s| s.parse().ok())
    }

    pub fn arg_i64(&self, n: usize) -> Option<i64> {
        self.arg(n).and_then(|s| s.parse().ok())
    }

    /// Append a child, inferring separator whitespace from the previous
    /// sibling so the file keeps its indentation style.
    pub fn push(&mut self, node: Node) {
        let n = self.children.len();
        // Reuse the whitespace that preceded the last child (its indentation),
        // falling back to a single space.
        let sep = if n == 0 {
            String::new()
        } else if self.ws[n - 1].is_empty() {
            " ".to_string()
        } else {
            self.ws[n - 1].clone()
        };
        let closing = self.ws.pop().unwrap_or_default();
        self.ws.push(sep);
        self.children.push(node);
        self.ws.push(closing);
        debug_assert_eq!(self.ws.len(), self.children.len() + 1);
    }

    /// Insert a child at `index`, reusing the whitespace that preceded the
    /// element currently at that index (or the last separator).
    pub fn insert(&mut self, index: usize, node: Node) {
        let n = self.children.len();
        let index = index.min(n);
        let sep = if n == 0 {
            String::new()
        } else if index < n {
            let candidate = self.ws[index].clone();
            if candidate.is_empty() && index > 0 {
                self.ws[index - 1].clone()
            } else {
                candidate
            }
        } else {
            self.ws[n - 1].clone()
        };
        let sep = if sep.is_empty() && n > 0 {
            " ".to_string()
        } else {
            sep
        };
        self.children.insert(index, node);
        self.ws.insert(index, sep);
        debug_assert_eq!(self.ws.len(), self.children.len() + 1);
    }

    /// Remove the child at `index` together with its preceding whitespace.
    pub fn remove(&mut self, index: usize) -> Node {
        let node = self.children.remove(index);
        self.ws.remove(index);
        // If we removed the last child, the closing whitespace now directly
        // follows the previous child; keep the invariant.
        debug_assert_eq!(self.ws.len(), self.children.len() + 1);
        node
    }

    /// Remove every child list named `name`. Returns how many were removed.
    pub fn remove_all(&mut self, name: &str) -> usize {
        let mut removed = 0;
        let mut i = 0;
        while i < self.children.len() {
            if matches!(&self.children[i], Node::List(l) if l.is_named(name)) {
                self.remove(i);
                removed += 1;
            } else {
                i += 1;
            }
        }
        removed
    }
}

impl Default for List {
    fn default() -> Self {
        List::new()
    }
}

impl Node {
    pub fn atom(value: &str) -> Node {
        Node::Atom(Atom::new(value))
    }
    pub fn quoted(value: &str) -> Node {
        Node::Atom(Atom::quoted(value))
    }
    pub fn bare(token: &str) -> Node {
        Node::Atom(Atom::bare(token))
    }
    pub fn list(l: List) -> Node {
        Node::List(l)
    }
    /// `(name arg arg ...)` in compact form.
    pub fn call(name: &str, args: &[&str]) -> Node {
        let mut children = Vec::with_capacity(args.len() + 1);
        children.push(Node::bare(name));
        for a in args {
            children.push(Node::atom(a));
        }
        Node::List(List::compact(children))
    }
    pub fn as_list(&self) -> Option<&List> {
        match self {
            Node::List(l) => Some(l),
            _ => None,
        }
    }
    pub fn as_list_mut(&mut self) -> Option<&mut List> {
        match self {
            Node::List(l) => Some(l),
            _ => None,
        }
    }
    pub fn as_atom(&self) -> Option<&Atom> {
        match self {
            Node::Atom(a) => Some(a),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Quoting (the single quoter of the engine)
// ---------------------------------------------------------------------------

/// True when `value` cannot be emitted as a bare token.
pub fn needs_quotes(value: &str) -> bool {
    value.is_empty()
        || value.bytes().any(|b| {
            matches!(b, b'(' | b')' | b'"' | b'\\')
                || b.is_ascii_whitespace()
                || b.is_ascii_control()
        })
}

/// Quote a decoded string the way KiCad's `OUTPUTFORMATTER::Quotes` does:
/// wrap in `"`, escape `\` as `\\`, `"` as `\"`, and `\n`/`\r`/`\t` as escape
/// sequences.
pub fn quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Inverse of [`quote`]. Accepts the raw token including quotes; unknown
/// escapes are kept as the escaped character (KiCad behaviour).
pub fn unquote(raw: &str) -> String {
    let inner = raw
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(raw);
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Parser (explicit stack, no recursion)
// ---------------------------------------------------------------------------

struct Cursor<'a> {
    src: &'a [u8],
    pos: usize,
    line: usize,
    line_start: usize,
}

impl<'a> Cursor<'a> {
    fn position(&self) -> Pos {
        Pos {
            offset: self.pos,
            line: self.line,
            col: self.pos - self.line_start + 1,
        }
    }
    fn peek(&self) -> Option<u8> {
        self.src.get(self.pos).copied()
    }
    fn bump(&mut self) {
        if self.src[self.pos] == b'\n' {
            self.line += 1;
            self.line_start = self.pos + 1;
        }
        self.pos += 1;
    }
    fn take_ws(&mut self) -> String {
        let start = self.pos;
        while let Some(b) = self.peek() {
            if b.is_ascii_whitespace() {
                self.bump();
            } else {
                break;
            }
        }
        // Whitespace is ASCII, so this slice is valid UTF-8.
        String::from_utf8_lossy(&self.src[start..self.pos]).into_owned()
    }
}

fn err(kind: ErrorKind, pos: Pos) -> Error {
    Error { kind, pos }
}

/// Parse a complete document with default limits.
pub fn parse(src: &str) -> Result<Document> {
    parse_with(src, Limits::default())
}

/// Parse a complete document with explicit limits.
pub fn parse_with(src: &str, limits: Limits) -> Result<Document> {
    if src.len() > limits.max_bytes {
        return Err(err(
            ErrorKind::LimitExceeded {
                what: "bytes",
                limit: limits.max_bytes,
            },
            Pos::default(),
        ));
    }
    let mut cur = Cursor {
        src: src.as_bytes(),
        pos: 0,
        line: 1,
        line_start: 0,
    };
    let leading_ws = cur.take_ws();
    match cur.peek() {
        None => return Err(err(ErrorKind::Empty, cur.position())),
        Some(b'(') => {}
        Some(b')') => return Err(err(ErrorKind::UnexpectedClose, cur.position())),
        Some(_) => return Err(err(ErrorKind::RootNotList, cur.position())),
    }
    // stack of open lists
    let mut stack: Vec<List> = Vec::new();
    let mut root: Option<List> = None;
    loop {
        match cur.peek() {
            None => {
                if !stack.is_empty() {
                    return Err(err(
                        ErrorKind::UnexpectedEof {
                            open_lists: stack.len(),
                        },
                        cur.position(),
                    ));
                }
                break;
            }
            Some(b'(') => {
                if root.is_some() {
                    return Err(err(ErrorKind::TrailingGarbage, cur.position()));
                }
                if stack.len() + 1 > limits.max_depth {
                    return Err(err(
                        ErrorKind::LimitExceeded {
                            what: "depth",
                            limit: limits.max_depth,
                        },
                        cur.position(),
                    ));
                }
                cur.bump();
                let ws = cur.take_ws();
                stack.push(List {
                    children: Vec::new(),
                    ws: vec![ws],
                });
            }
            Some(b')') => {
                let close_pos = cur.position();
                let Some(list) = stack.pop() else {
                    return Err(err(ErrorKind::UnexpectedClose, close_pos));
                };
                cur.bump();
                let ws_after = cur.take_ws();
                match stack.last_mut() {
                    Some(parent) => {
                        if parent.children.len() + 1 > limits.max_children {
                            return Err(err(
                                ErrorKind::LimitExceeded {
                                    what: "children",
                                    limit: limits.max_children,
                                },
                                close_pos,
                            ));
                        }
                        parent.children.push(Node::List(list));
                        parent.ws.push(ws_after);
                    }
                    None => {
                        root = Some(list);
                        // ws_after is the document trailing whitespace; anything
                        // else after it is garbage.
                        if cur.peek().is_some() {
                            return Err(err(ErrorKind::TrailingGarbage, cur.position()));
                        }
                        return Ok(Document {
                            leading_ws,
                            root: root.unwrap(),
                            trailing_ws: ws_after,
                        });
                    }
                }
            }
            Some(b'"') => {
                let start = cur.pos;
                let start_pos = cur.position();
                cur.bump();
                let mut closed = false;
                while let Some(b) = cur.peek() {
                    if b == b'\\' {
                        cur.bump();
                        if cur.peek().is_some() {
                            cur.bump();
                        }
                        continue;
                    }
                    if b == b'"' {
                        cur.bump();
                        closed = true;
                        break;
                    }
                    cur.bump();
                }
                if !closed {
                    return Err(err(ErrorKind::UnterminatedString, start_pos));
                }
                let raw = &src[start..cur.pos];
                if raw.len() > limits.max_atom_bytes {
                    return Err(err(
                        ErrorKind::LimitExceeded {
                            what: "atom_bytes",
                            limit: limits.max_atom_bytes,
                        },
                        start_pos,
                    ));
                }
                let ws_after = cur.take_ws();
                push_atom(&mut stack, raw, ws_after, &limits, start_pos)?;
            }
            Some(_) => {
                if root.is_some() {
                    return Err(err(ErrorKind::TrailingGarbage, cur.position()));
                }
                let start = cur.pos;
                let start_pos = cur.position();
                while let Some(b) = cur.peek() {
                    if b.is_ascii_whitespace() || matches!(b, b'(' | b')' | b'"') {
                        break;
                    }
                    cur.bump();
                }
                let raw = &src[start..cur.pos];
                if raw.len() > limits.max_atom_bytes {
                    return Err(err(
                        ErrorKind::LimitExceeded {
                            what: "atom_bytes",
                            limit: limits.max_atom_bytes,
                        },
                        start_pos,
                    ));
                }
                let ws_after = cur.take_ws();
                push_atom(&mut stack, raw, ws_after, &limits, start_pos)?;
            }
        }
    }
    Err(err(ErrorKind::Empty, cur.position()))
}

fn push_atom(
    stack: &mut [List],
    raw: &str,
    ws_after: String,
    limits: &Limits,
    pos: Pos,
) -> Result<()> {
    let Some(parent) = stack.last_mut() else {
        return Err(err(ErrorKind::RootNotList, pos));
    };
    if parent.children.len() + 1 > limits.max_children {
        return Err(err(
            ErrorKind::LimitExceeded {
                what: "children",
                limit: limits.max_children,
            },
            pos,
        ));
    }
    parent.children.push(Node::Atom(Atom {
        raw: raw.to_string(),
    }));
    parent.ws.push(ws_after);
    Ok(())
}

// ---------------------------------------------------------------------------
// Serialiser (explicit stack, no recursion)
// ---------------------------------------------------------------------------

/// Serialise a document byte-for-byte as parsed (or as edited).
pub fn dumps(doc: &Document) -> String {
    let mut out = String::new();
    out.push_str(&doc.leading_ws);
    write_list(&doc.root, &mut out);
    out.push_str(&doc.trailing_ws);
    out
}

/// Serialise a single list.
pub fn dumps_list(list: &List) -> String {
    let mut out = String::new();
    write_list(list, &mut out);
    out
}

fn write_list(root: &List, out: &mut String) {
    // frame: (list, next child index)
    let mut stack: Vec<(&List, usize)> = vec![(root, 0)];
    out.push('(');
    out.push_str(&root.ws[0]);
    while let Some((list, idx)) = stack.last_mut() {
        if *idx < list.children.len() {
            let i = *idx;
            *idx += 1;
            match &list.children[i] {
                Node::Atom(a) => {
                    out.push_str(&a.raw);
                    out.push_str(&list.ws[i + 1]);
                }
                Node::List(child) => {
                    out.push('(');
                    out.push_str(&child.ws[0]);
                    stack.push((child, 0));
                }
            }
        } else {
            out.push(')');
            stack.pop();
            if let Some((parent, pidx)) = stack.last() {
                // whitespace after the child we just closed
                out.push_str(&parent.ws[*pidx]);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Pretty formatting for freshly created subtrees (KiCad 8+ style: tabs)
// ---------------------------------------------------------------------------

/// Re-layout `list` recursively in KiCad's formatter style: every child list
/// starts on a new line indented by `indent + 1` tabs, atoms are separated by
/// single spaces, and the closing paren of a list that contains child lists is
/// on its own line. Leaf lists (atoms only) stay compact.
pub fn pretty(list: &mut List, indent: usize) {
    // explicit stack of (list pointer, indent)
    let mut stack: Vec<(*mut List, usize)> = vec![(list as *mut List, indent)];
    while let Some((ptr, ind)) = stack.pop() {
        // SAFETY: pointers come from a tree we own mutably; each node is
        // visited exactly once and no aliasing references are held across
        // iterations.
        let l = unsafe { &mut *ptr };
        let has_child_list = l.children.iter().any(|c| matches!(c, Node::List(_)));
        let n = l.children.len();
        l.ws = Vec::with_capacity(n + 1);
        l.ws.push(String::new());
        for i in 0..n {
            let is_last = i + 1 == n;
            let next_is_list = !is_last && matches!(l.children[i + 1], Node::List(_));
            let sep = if is_last {
                if has_child_list {
                    format!("\n{}", "\t".repeat(ind))
                } else {
                    String::new()
                }
            } else if next_is_list {
                format!("\n{}", "\t".repeat(ind + 1))
            } else {
                " ".to_string()
            };
            l.ws.push(sep);
        }
        for c in l.children.iter_mut() {
            if let Node::List(child) = c {
                stack.push((child as *mut List, ind + 1));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_simple() {
        let src = "(a b \"c d\"\n\t(e 1.5 -2)\n)\n";
        let doc = parse(src).unwrap();
        assert_eq!(dumps(&doc), src);
        assert_eq!(doc.root.name().as_deref(), Some("a"));
        assert_eq!(doc.root.find("e").unwrap().arg_f64(0), Some(1.5));
    }

    #[test]
    fn quote_unquote() {
        let v = "he said \"hi\"\\n\tx";
        assert_eq!(unquote(&quote(v)), v);
        assert_eq!(Atom::new("plain").raw, "plain");
        assert_eq!(Atom::new("").raw, "\"\"");
        assert_eq!(Atom::new("a b").raw, "\"a b\"");
    }

    #[test]
    fn errors() {
        assert_eq!(parse("").unwrap_err().kind, ErrorKind::Empty);
        assert_eq!(
            parse("(a").unwrap_err().kind,
            ErrorKind::UnexpectedEof { open_lists: 1 }
        );
        assert_eq!(parse(")").unwrap_err().kind, ErrorKind::UnexpectedClose);
        assert_eq!(parse("(a) x").unwrap_err().kind, ErrorKind::TrailingGarbage);
        assert_eq!(
            parse("(a \"x)").unwrap_err().kind,
            ErrorKind::UnterminatedString
        );
        assert_eq!(parse("x").unwrap_err().kind, ErrorKind::RootNotList);
        let deep = "(".repeat(600) + &")".repeat(600);
        assert!(matches!(
            parse(&deep).unwrap_err().kind,
            ErrorKind::LimitExceeded { what: "depth", .. }
        ));
    }

    #[test]
    fn push_keeps_style() {
        let src = "(root\n\t(a 1)\n\t(b 2)\n)";
        let mut doc = parse(src).unwrap();
        doc.root.push(Node::call("c", &["3"]));
        assert_eq!(dumps(&doc), "(root\n\t(a 1)\n\t(b 2)\n\t(c 3)\n)");
        doc.root.remove(1);
        assert_eq!(dumps(&doc), "(root\n\t(b 2)\n\t(c 3)\n)");
    }

    #[test]
    fn pretty_layout() {
        let mut l = List::compact(vec![
            Node::bare("symbol"),
            Node::quoted("Device:R"),
            Node::call("at", &["1", "2", "0"]),
            Node::call("uuid", &["x"]),
        ]);
        pretty(&mut l, 1);
        assert_eq!(
            dumps_list(&l),
            "(symbol \"Device:R\"\n\t\t(at 1 2 0)\n\t\t(uuid x)\n\t)"
        );
    }
}
