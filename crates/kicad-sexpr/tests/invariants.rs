// SPDX-License-Identifier: Apache-2.0
//! L1 invariant tests owned by kicad-sexpr (docs/engine-architecture.md I1–I4, I25)
//! plus deterministic "ugly input" coverage for the structured-error path (L7 companion).

use kicad_sexpr::{dumps, parse, parse_with, ErrorKind, Limits, Node};

const ODD: &str = "(kicad_sch\n\t(version 20260306)\n  (weird_future_node   \"x\"  (nested 1 2.50 (deeper)))\n\t(paper \"A4\")\n\t(uuid \"11111111-1111-4111-8111-111111111111\")\n)\n";

#[test]
fn inv_1_roundtrip_byte_identical_and_unknown_nodes_preserved() {
    let doc = parse(ODD).unwrap();
    assert_eq!(
        dumps(&doc),
        ODD,
        "dumps(parse(x)) must equal x byte for byte"
    );
    let unknown = doc
        .root
        .find("weird_future_node")
        .expect("unknown node kept in tree");
    assert_eq!(unknown.arg(0).as_deref(), Some("x"));
    assert!(unknown.find("nested").is_some());
    // spacing / tabs / trailing newline are all preserved as well
    let tricky = "(a   b\t\t(c \"q q\")\n\n)";
    assert_eq!(dumps(&parse(tricky).unwrap()), tricky);
}

#[test]
fn inv_2_single_quoter_escapes_control_characters() {
    for (raw, expect) in [
        ("plain", "\"plain\""),
        ("a\nb", "\"a\\nb\""),
        ("a\tb", "\"a\\tb\""),
        ("a\rb", "\"a\\rb\""),
        ("say \"hi\"", "\"say \\\"hi\\\"\""),
        ("back\\slash", "\"back\\\\slash\""),
        ("", "\"\""),
    ] {
        let q = kicad_sexpr::quote(raw);
        assert_eq!(q, expect, "quote({raw:?})");
        assert_eq!(
            kicad_sexpr::unquote(&q),
            raw,
            "unquote(quote(x)) == x for {raw:?}"
        );
    }
    for c in ["a b", "a(b", "a)b", "\"", "\\", "\u{1}", "", "x\ny"] {
        assert!(kicad_sexpr::needs_quotes(c), "{c:?} must be quoted");
    }
    assert!(!kicad_sexpr::needs_quotes("bare_token-1.5"));
    // The writer emits every quoted atom through the same quoter: a title with a newline
    // serialises to an escape sequence and never to a raw newline inside quotes.
    let mut l = kicad_sexpr::List::new();
    l.push(Node::bare("title"));
    l.push(Node::quoted("line1\nline2"));
    let out = kicad_sexpr::dumps_list(&l);
    assert!(out.contains("\"line1\\nline2\""), "{out}");
    assert!(!out.contains("line1\nline2"));
    assert_eq!(
        parse(&format!("({out})"))
            .unwrap()
            .root
            .find("title")
            .unwrap()
            .arg(0)
            .as_deref(),
        Some("line1\nline2")
    );
}

#[test]
fn inv_3_limits_yield_structured_errors_not_panics() {
    let lim = Limits {
        max_bytes: 1 << 20,
        max_depth: 8,
        max_children: 64,
        max_atom_bytes: 16,
    };
    let deep = format!("{}a{}", "(".repeat(20), ")".repeat(20));
    match parse_with(&deep, lim) {
        Err(e) => assert!(
            matches!(e.kind, ErrorKind::LimitExceeded { what: "depth", .. }),
            "{e:?}"
        ),
        Ok(_) => panic!("depth limit not enforced"),
    }
    let wide = format!("(a {})", "b ".repeat(100));
    assert!(matches!(
        parse_with(&wide, lim).unwrap_err().kind,
        ErrorKind::LimitExceeded {
            what: "children",
            ..
        }
    ));
    let atom = format!("(a {})", "x".repeat(64));
    assert!(matches!(
        parse_with(&atom, lim).unwrap_err().kind,
        ErrorKind::LimitExceeded {
            what: "atom_bytes",
            ..
        }
    ));
    let big = Limits {
        max_bytes: 8,
        ..lim
    };
    assert!(matches!(
        parse_with("(a b c d e f)", big).unwrap_err().kind,
        ErrorKind::LimitExceeded { what: "bytes", .. }
    ));
    // default limits: a 100k-deep input must not overflow the stack (explicit stack, no recursion)
    let very_deep = format!("{}{}", "(".repeat(100_000), ")".repeat(100_000));
    assert!(parse(&very_deep).is_err());
}

#[test]
fn inv_25_serialisation_is_deterministic() {
    let doc = parse(ODD).unwrap();
    let a = dumps(&doc);
    let b = dumps(&parse(&a).unwrap());
    assert_eq!(a, b);
    // pretty-printing a freshly built tree is deterministic across calls too
    let mut l1 = kicad_sexpr::List::new();
    l1.push(Node::bare("root"));
    l1.push(Node::call("at", &["1.27", "2.54"]));
    l1.push(Node::call("uuid", &["x"]));
    let mut l2 = l1.clone();
    kicad_sexpr::pretty(&mut l1, 0);
    kicad_sexpr::pretty(&mut l2, 0);
    assert_eq!(kicad_sexpr::dumps_list(&l1), kicad_sexpr::dumps_list(&l2));
}

/// Ugly inputs that must all come back as `Err(structured)` or `Ok`, never panic.
#[test]
fn ugly_inputs_never_panic() {
    let mut cases: Vec<String> = vec![
        String::new(),
        "(".into(),
        ")".into(),
        "(a".into(),
        "(a \"unterminated".into(),
        "(a \"esc\\".into(),
        "(a)(b)".into(),
        "(a b))".into(),
        "\u{0}(".into(),
        "(a \\)".into(),
        "bare".into(),
        "   \n\t ".into(),
        "(a \"\\q\")".into(),
        "(a \u{feff}b)".into(),
        "(a 1e999 -0.0 .5 5.)".into(),
        "(a \"x\"\"y\")".into(),
        format!("(a \"{}\")", "\\\"".repeat(10_000)),
        format!("(a {})", "\"\" ".repeat(50_000)),
        format!("(a {}", "(b ".repeat(5_000)),
        format!("({})", "x".repeat(2_000_000)),
        "(a (b (c (d (e (f (g (h (i (j)))))))))".into(),
    ];
    // truncations of a real file at every 97th byte
    let fx = std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/conformance/fixtures/hier/hier_root.kicad_sch"),
    )
    .unwrap();
    let mut cut = 0;
    while cut < fx.len() {
        if fx.is_char_boundary(cut) {
            cases.push(fx[..cut].to_string());
        }
        cut += 97;
    }
    for c in &cases {
        match parse(c) {
            Ok(d) => {
                let s = dumps(&d);
                assert_eq!(&s, c, "successful parse must round-trip");
            }
            Err(e) => {
                let _ = format!("{e}");
            }
        }
    }
    // invalid UTF-8 via the bytes path (if exposed) is covered by the fuzz target; the
    // `&str` API cannot receive it.
}
