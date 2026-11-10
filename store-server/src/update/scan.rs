//! Runtime guard behind Plan 04's CI lint: statements that change the CLUSTER (roles, databases, tablespaces, server
//! settings, OS commands) cannot be undone by dropping the clone, so a pack that contains one is refused.
//!
//! The scan lexes PostgreSQL's quoting rules just far enough to know where a comment or a string really starts: nested
//! block comments, `'..'` (with `E'..'` backslash escapes only after an E that is not part of a longer word), `".."`,
//! and `$tag$..$tag$` (which opens only after a non-identifier character). Bodies of strings, identifiers and dollar quotes
//! are scanned on purpose (`EXECUTE 'ALTER ROLE ..'` is a hit). Anything it cannot close (an unterminated comment, string,
//! identifier or dollar quote), a psql meta-command (`\`), and the two settings that change how strings are read
//! (`standard_conforming_strings`, `backslash_quote`) come back as hits too, so both callers fail closed.
//! A mis-lex CAN hide a statement; it cannot see one assembled at run time (`'AL' || 'TER ROLE'`) either. The cluster digest
//! before and after the work is the backstop for both.

// Postgres counts every byte >= 0x80 as an identifier and dollar-tag character, so every non-ASCII char is one here
fn is_tag_char(c: char) -> bool { c.is_ascii_alphanumeric() || c == '_' || !c.is_ascii() }
fn is_ident(c: char) -> bool { is_tag_char(c) || c == '$' }

/// `$tag$` at `i`: the tag (without the dollars) when it opens a dollar quote there.
fn dollar_tag(b: &[char], i: usize) -> Option<String> {
    if i > 0 && is_ident(b[i - 1]) { return None; }
    let mut j = i + 1;
    if j < b.len() && is_tag_char(b[j]) && !b[j].is_ascii_digit() {
        while j < b.len() && is_tag_char(b[j]) { j += 1; }
    }
    (j < b.len() && b[j] == '$').then(|| b[i + 1..j].iter().collect())
}

pub fn scan_forbidden(sql: &str) -> Vec<String> { scan_forbidden_stmts(sql).into_iter().map(|(label, _)| label).collect() }

/// A statement as an operator should read it in a refusal: comments gone, whitespace collapsed, no trailing `;`, cut at 80 chars.
fn snippet(stmt: &str) -> String {
    let one = stmt.split_whitespace().collect::<Vec<_>>().join(" ");
    let one = one.trim_end_matches(';').trim_end();
    if one.chars().count() > 80 { format!("{}...", one.chars().take(80).collect::<String>()) } else { one.to_string() }
}

/// The scan's hits as (label, snippet of the statement that caused it). The labels are exactly `scan_forbidden`'s.
pub fn scan_forbidden_stmts(sql: &str) -> Vec<(String, String)> {
    let b: Vec<char> = sql.chars().collect();
    let mut clean = String::with_capacity(sql.len());
    let mut found: Vec<String> = vec![];
    // byte offsets in `clean` where a top-level statement starts; `at` = the statement start of each lexer hit
    let (mut starts, mut at, mut start) = (vec![0usize], Vec::<usize>::new(), 0usize);
    let mut i = 0;
    while i < b.len() {
        while at.len() < found.len() { at.push(start); }
        let c = b[i];
        if c == '-' && b.get(i + 1) == Some(&'-') {
            while i < b.len() && b[i] != '\n' { i += 1; }
        } else if c == '/' && b.get(i + 1) == Some(&'*') {
            let (mut depth, mut j) = (1, i + 2);
            while j < b.len() && depth > 0 {
                if b[j] == '/' && b.get(j + 1) == Some(&'*') { depth += 1; j += 2; }
                else if b[j] == '*' && b.get(j + 1) == Some(&'/') { depth -= 1; j += 2; }
                else { j += 1; }
            }
            if depth > 0 { found.push("UNTERMINATED_COMMENT".into()); }
            clean.push(' ');
            i = j;
        } else if c == '\'' {
            // E'..' only when the E stands alone (not the tail of a longer word); there \x and '' are escapes, elsewhere a backslash is text
            let e_string = i > 0 && matches!(b[i - 1], 'e' | 'E') && (i < 2 || !is_ident(b[i - 2]));
            clean.push(c);
            i += 1;
            let mut closed = false;
            while i < b.len() {
                if e_string && b[i] == '\\' && i + 1 < b.len() { clean.push(b[i]); clean.push(b[i + 1]); i += 2; continue; }
                if b[i] == '\'' {
                    if b.get(i + 1) == Some(&'\'') { clean.push_str("''"); i += 2; continue; }
                    closed = true;
                    break;
                }
                clean.push(b[i]);
                i += 1;
            }
            if closed { clean.push('\''); i += 1; } else { found.push("UNTERMINATED_STRING".into()); }
        } else if c == '"' {
            clean.push(c);
            i += 1;
            let mut closed = false;
            while i < b.len() {
                if b[i] == '"' {
                    if b.get(i + 1) == Some(&'"') { clean.push_str("\"\""); i += 2; continue; }
                    closed = true;
                    break;
                }
                clean.push(b[i]);
                i += 1;
            }
            if closed { clean.push('"'); i += 1; } else { found.push("UNTERMINATED_IDENTIFIER".into()); }
        } else if c == '$' && dollar_tag(&b, i).is_some() {
            let tag = dollar_tag(&b, i).unwrap_or_default();
            let open: Vec<char> = format!("${tag}$").chars().collect();
            clean.extend(open.iter());
            let mut j = i + open.len();
            let mut closed = false;
            while j < b.len() {
                if b[j..].starts_with(&open) { closed = true; break; }
                clean.push(b[j]);
                j += 1;
            }
            if closed { clean.extend(open.iter()); j += open.len(); } else { found.push("UNTERMINATED_DOLLAR_QUOTE".into()); }
            i = j;
        } else if c == '\\' {
            // outside every quoted form: psql would run it client-side, as posctl
            found.push("META_COMMAND".into());
            clean.push(' ');
            i += 1;
        } else {
            clean.push(c);
            i += 1;
            if c == ';' { start = clean.len(); starts.push(start); }
        }
    }
    while at.len() < found.len() { at.push(start); }
    let lexer_hits = found.len();
    analyze(&clean, &mut found);
    let end = |k: usize| starts.get(k + 1).copied().unwrap_or(clean.len());
    let stmts: Vec<&str> = starts.iter().enumerate().map(|(k, &s)| &clean[s..end(k)]).collect();
    found.into_iter().enumerate().map(|(n, label)| {
        let text = if n < lexer_hits { clean[at[n]..].to_string() } else {
            // the first statement that raises this label on its own; the whole text when none does (a hit that spans statements)
            stmts.iter().find(|s| { let mut f = vec![]; analyze(s, &mut f); f.contains(&label) }).map_or_else(|| clean.clone(), |s| s.to_string())
        };
        (label, snippet(&text))
    }).collect()
}

fn analyze(clean: &str, found: &mut Vec<String>) {
    let up = clean.to_uppercase();
    for setting in ["STANDARD_CONFORMING_STRINGS", "BACKSLASH_QUOTE"] {
        if up.contains(setting) { found.push(format!("SETTING {setting}")); }
    }
    let toks: Vec<&str> = up.split(|c: char| c.is_whitespace() || ";(),'\"$".contains(c)).filter(|t| !t.is_empty()).collect();
    for w in toks.windows(2) {
        let hit = matches!((w[0], w[1]),
            ("CREATE" | "ALTER" | "DROP", "ROLE" | "USER" | "GROUP" | "DATABASE" | "TABLESPACE" | "SUBSCRIPTION")
            | ("ALTER", "SYSTEM") | ("CREATE", "EXTENSION") | ("DROP" | "REASSIGN", "OWNED") | ("COPY", "PROGRAM"));
        if hit { found.push(format!("{} {}", w[0], w[1])); }
    }
    for t in &toks {
        // schema-qualified (`pg_catalog.pg_read_file`) is the same function
        let name = t.rsplit('.').next().unwrap_or(t);
        if matches!(name, "LO_IMPORT" | "LO_EXPORT" | "PG_READ_FILE" | "PG_READ_BINARY_FILE" | "PG_LS_DIR" | "PG_STAT_FILE") { found.push(name.to_string()); }
    }
    scan_copy(&up, found);
}

/// COPY .. PROGRAM, and COPY .. FROM|TO <anything but STDIN/STDOUT> (an allow-list: a quoted, dollar-quoted, `E'..'`,
/// `U&'..'` or bare target is a server-side file). Statement by statement over a flat token stream; the quote characters
/// are tokens of their own so `FROM $$STDIN$$` is not `FROM STDIN`. The COPY's own FROM/TO is the first one at its own
/// paren depth, so `COPY (SELECT .. FROM t) TO STDOUT` passes. A lint, not a boundary: see docs/two-mode/unattended-updates.md.
fn scan_copy(up: &str, found: &mut Vec<String>) {
    let (mut toks, mut word) = (Vec::<String>::new(), String::new());
    for c in up.chars() {
        if c.is_whitespace() || c == ',' || "();'\"$".contains(c) {
            if !word.is_empty() { toks.push(std::mem::take(&mut word)); }
            if !c.is_whitespace() && c != ',' { toks.push(c.to_string()); }
        } else { word.push(c); }
    }
    if !word.is_empty() { toks.push(word); }
    // (base depth, direction seen, expecting the target) of the COPY being read
    let (mut copy, mut depth, mut prev, mut expect) = (None::<(usize, bool)>, 0usize, ";", false);
    for t in &toks {
        let t = t.as_str();
        if expect {
            expect = false;
            if !matches!(t, "STDIN" | "STDOUT") { found.push("COPY .. FILE".to_string()); }
            if t == "PROGRAM" { found.push("COPY .. PROGRAM".to_string()); }
            if t == ";" { copy = None; depth = 0; }
        } else if t == "COPY" && copy.is_none() && matches!(prev, ";" | "'" | "$" | "\"" | "BEGIN" | "THEN" | "ELSE" | "LOOP") {
            copy = Some((depth, false));
        } else if let Some((base, seen)) = copy {
            match t {
                ";" => { if depth != base { found.push("COPY .. FILE".to_string()); } copy = None; depth = 0; }
                "(" => depth += 1,
                ")" => depth = depth.saturating_sub(1),
                "PROGRAM" => found.push("COPY .. PROGRAM".to_string()),
                "FROM" | "TO" if !seen && depth == base => { copy = Some((base, true)); expect = true; }
                _ => {}
            }
        } else if t == ";" { depth = 0; }
        else if t == "(" { depth += 1; }
        else if t == ")" { depth = depth.saturating_sub(1); }
        prev = t;
    }
    // a COPY still open at the end (unbalanced parens swallowed its direction) fails closed
    if let Some((base, _)) = copy { if depth != base { found.push("COPY .. FILE".to_string()); } }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cluster_wide_statements_are_found_case_and_whitespace_insensitively() {
        for sql in ["CREATE ROLE x;", "alter\n  role x set a=1;", "ALTER USER x;", "DROP ROLE x;", "ALTER DATABASE postgres SET a=1;",
                    "ALTER SYSTEM SET a=1;", "do $$ begin execute 'ALTER ROLE r NOLOGIN'; end $$;"] {
            assert!(!scan_forbidden(sql).is_empty(), "{sql}");
        }
    }
    #[test]
    fn comments_and_ordinary_ddl_are_not_flagged() {
        let sql = "-- ALTER DATABASE postgres SET app.x = 1;\n/* CREATE ROLE y */\nCREATE TABLE t(a int); ALTER TABLE t ADD COLUMN b int; GRANT SELECT ON t TO anon; ALTER FUNCTION f() OWNER TO postgres;";
        assert!(scan_forbidden(sql).is_empty());
    }

    // --- fail closed: ways a statement can hide from a naive scan ---
    #[test]
    fn a_comment_marker_inside_a_string_does_not_hide_what_follows() {
        for sql in ["SELECT '--'; ALTER ROLE x NOLOGIN;", "SELECT '/*'; DROP ROLE x; SELECT '*/';", "select e'\\'--'; create role r;",
                    "SELECT $$--$$; ALTER SYSTEM SET a=1;", "SELECT $tag$/*$tag$; CREATE USER u;"] {
            assert!(!scan_forbidden(sql).is_empty(), "hidden behind a string: {sql}");
        }
    }
    #[test]
    fn comments_between_the_words_do_not_hide_a_statement() {
        for sql in ["ALTER/**/ROLE x;", "ALTER /* a */ ROLE x;", "CREATE -- c\n ROLE x;", "ALTER \"ROLE\" x;"] {
            assert!(!scan_forbidden(sql).is_empty(), "{sql}");
        }
    }
    #[test]
    fn the_rest_of_the_cluster_level_surface_is_refused_too() {
        for sql in ["CREATE DATABASE d;", "DROP DATABASE d;", "CREATE TABLESPACE t LOCATION 'x';", "ALTER TABLESPACE t RENAME TO u;",
                    "CREATE SUBSCRIPTION s CONNECTION 'x' PUBLICATION p;", "DROP OWNED BY r;", "REASSIGN OWNED BY a TO b;",
                    "COPY t FROM PROGRAM 'calc';", "COPY t TO PROGRAM 'x';"] {
            assert!(!scan_forbidden(sql).is_empty(), "{sql}");
        }
    }
    #[test]
    fn server_side_file_and_program_access_is_refused_however_long_the_column_list() {
        for (sql, want) in [("COPY t (a,b,c,d,e,f,g,h) FROM PROGRAM 'x';", "PROGRAM"), ("COPY t (a,b,c,d,e,f,g,h,i,j) TO PROGRAM 'x';", "PROGRAM"),
                            ("COPY t TO '/tmp/x';", "COPY .. FILE"), ("copy t from E'/tmp/x';", "COPY .. FILE"),
                            ("COPY (SELECT 1) TO '/tmp/x';", "COPY .. FILE"),
                            ("SELECT lo_import('x');", "LO_IMPORT"), ("select LO_EXPORT(1, 'x');", "LO_EXPORT"),
                            ("create extension foo;", "CREATE EXTENSION")] {
            assert!(has(sql, want), "{sql}");
        }
        for sql in ["COPY t FROM STDIN;", "COPY t (a,b) TO STDOUT;", "COPY t FROM STDIN WITH (DELIMITER ',');", "SELECT 'x' FROM t;", "CREATE TABLE extension(x int);"] {
            assert!(scan_forbidden(sql).is_empty(), "{sql}");
        }
    }
    #[test]
    fn copy_targets_are_allow_listed_to_stdin_and_stdout() {
        for sql in ["COPY t FROM $$/etc/x$$;", "COPY t FROM $tag$/etc/x$tag$;", "COPY t TO U&'\\0041';", "COPY t FROM E'x';", "copy t to 'x';",
                    "COPY t FROM \"stdin\";", "COPY t FROM '/x' WITH (FORMAT csv);", "COPY t FROM /etc/x;", "COPY (SELECT 1) TO $$/tmp/x$$;",
                    "COPY t FROM $$STDIN$$;", "COPY t (a,b) FROM 'STDIN';", "DO $$ BEGIN COPY t FROM $x$/etc/p$x$; END $$;"] {
            assert!(has(sql, "COPY .. FILE"), "{sql}");
        }
        for sql in ["COPY t FROM STDIN;", "copy t to stdout;", "COPY (SELECT a FROM t WHERE b IN (1,2)) TO STDOUT;",
                    "COPY t (a, b) FROM STDIN WITH (FORMAT csv, DELIMITER ',');", "COPY public.t FROM STDIN;", "SELECT copy FROM t;",
                    "COPY (SELECT 1) TO STDOUT WITH CSV HEADER;"] {
            assert!(scan_forbidden(sql).is_empty(), "{sql}: {:?}", scan_forbidden(sql));
        }
    }
    #[test]
    fn server_file_read_functions_are_refused_in_any_case() {
        for (sql, want) in [("SELECT pg_read_file('x');", "PG_READ_FILE"), ("select PG_Read_Binary_File('x');", "PG_READ_BINARY_FILE"),
                            ("SELECT * FROM pg_ls_dir('.');", "PG_LS_DIR"), ("SELECT pg_catalog.pg_stat_file('x');", "PG_STAT_FILE")] {
            assert!(has(sql, want), "{sql}");
        }
    }
    #[test]
    fn an_unterminated_block_comment_is_reported_not_trusted() {
        assert!(has("SELECT 1; /* never closed ALTER ROLE x;", "UNTERMINATED_COMMENT"));
    }

    // ---- FR5b item 1: the lexer ----
    fn has(sql: &str, want: &str) -> bool { scan_forbidden(sql).iter().any(|h| h.contains(want)) }

    #[test]
    fn adversarial_snippets() {
        // (snippet, Some(hit) = must be reported, None = must be silent)
        let table: Vec<(&str, Option<&str>)> = vec![
            ("/* /* */ -- */ ALTER ROLE postgres SET search_path=x;", Some("ALTER ROLE")),
            ("CREATE TABLE \"a--\"(x int); ALTER DATABASE postgres CONNECTION LIMIT 0;", Some("ALTER DATABASE")),
            ("SELECT 1 AS x$q$; SELECT $q$ -- $q$; ALTER ROLE r NOLOGIN;", Some("ALTER ROLE")),
            ("SELECT 1 AS a$$; ALTER ROLE r NOLOGIN; --$$", Some("ALTER ROLE")),
            ("SET standard_conforming_strings=off; SELECT 'x\\' -- '; ALTER ROLE r NOLOGIN;", Some("SETTING")),
            ("SELECT set_config('backslash_quote','on',false);", Some("SETTING")),
            ("SELECT U&\"a--\" ; ALTER SYSTEM SET work_mem='1MB';", Some("ALTER SYSTEM")),
            ("SELECT 'abc", Some("UNTERMINATED_STRING")),
            ("SELECT \"abc", Some("UNTERMINATED_IDENTIFIER")),
            ("SELECT $q$ abc", Some("UNTERMINATED_DOLLAR_QUOTE")),
            ("/* abc", Some("UNTERMINATED_COMMENT")),
            ("SELECT 1; \\! calc", Some("META_COMMAND")),
            ("SELECT 1;\n\\copy t to 'f'", Some("META_COMMAND")),
            ("SELECT E'\\'' -- '; DROP DATABASE x;", None),
            ("SELECT 'x\\' ; DROP DATABASE x; --'", Some("DROP DATABASE")),
            ("SELECT $a$ $$ $a$; ALTER ROLE r NOLOGIN;", Some("ALTER ROLE")),
            ("/* a /* b */ ALTER ROLE r NOLOGIN; */ SELECT 1;", None),
            ("\"ALTER\" ROLE x;", Some("ALTER ROLE")),
            ("ALTER/**/ROLE x;", Some("ALTER ROLE")),
            ("ALTER\nROLE x;", Some("ALTER ROLE")),
            ("aLtEr RoLe x;", Some("ALTER ROLE")),
            // FR9 item 1: bytes >= 0x80 are identifier and dollar-tag characters in Postgres
            ("SELECT 1 AS \u{20ac}$q$; SELECT $q$ -- $q$; ALTER ROLE r NOLOGIN;", Some("ALTER ROLE")),
            ("SELECT $\u{e9}$ -- $\u{e9}$; \\! calc", Some("META_COMMAND")),
            ("SELECT $\u{e9}$ it's $\u{e9}$; ALTER ROLE r NOLOGIN; --'", Some("ALTER ROLE")),
            ("SELECT $\u{4e2d}x$ -- $\u{4e2d}x$; DROP DATABASE d;", Some("DROP DATABASE")),
            // benign
            ("SELECT $\u{e9}$ plain text $\u{e9}$;", None),
            ("COMMENT ON TABLE t IS 'role admin';", None),
            ("CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;", None),
            ("CREATE TABLE alter_role(x int); SELECT x AS role FROM alter_role WHERE x = $1;", None),
        ];
        let mut wrong = vec![];
        for (sql, want) in table {
            let got = scan_forbidden(sql);
            let ok = match want { Some(w) => got.iter().any(|h| h.contains(w)), None => got.is_empty() };
            if !ok { wrong.push(format!("{sql:?}: wanted {want:?}, got {got:?}")); }
        }
        assert!(wrong.is_empty(), "\n{}", wrong.join("\n"));
    }

    #[test]
    fn a_string_that_contains_alter_role_is_refused_by_design() { assert!(has("SELECT 'ALTER ROLE x';", "ALTER ROLE")); }

    // The two pre-base historical migrations that CREATE EXTENSION (already applied everywhere; the pack's trusted stub extensions
    // let a non-superuser create vector and pg_net). Pinned by filename AND sha256 of the content with CRLF folded to LF
    // (git autocrlf can change the bytes on a Windows checkout). An edited copy is not exempt. Test-only: the runtime scan has none.
    const EXTENSION_EXEMPT: [(&str, &str); 2] = [
        ("20260506000002_agent_rag_schema.sql", "0ae1a7e08b395f1557f9472076c623e10efe905129292af674a12af04b7b60bf"),
        ("20260807000001_pool_session_atomic_rpcs.sql", "ff2d10efb451774e3ba84153d975ee3398526cb14625cab8fbfbbb6d4b4504dc"),
    ];
    fn extension_exempt(name: &str, sql: &str) -> bool {
        use sha2::{Digest, Sha256};
        let digest = crate::update::manifest::hex(&Sha256::digest(sql.replace("\r\n", "\n").as_bytes()));
        EXTENSION_EXEMPT.iter().any(|(n, h)| *n == name && *h == digest)
    }

    #[test]
    fn every_repo_migration_scans_clean() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("supabase").join("migrations");
        let mut bad = vec![];
        let mut n = 0;
        for e in std::fs::read_dir(&dir).expect("supabase/migrations").flatten() {
            if e.path().extension().is_some_and(|x| x == "sql") {
                n += 1;
                let sql = std::fs::read_to_string(e.path()).unwrap();
                let mut hits = scan_forbidden(&sql);
                if extension_exempt(&e.file_name().to_string_lossy(), &sql) { hits.retain(|h| h != "CREATE EXTENSION"); }
                if !hits.is_empty() { bad.push(format!("{}: {hits:?}", e.file_name().to_string_lossy())); }
            }
        }
        assert!(n > 200, "only {n} migrations found");
        assert!(bad.is_empty(), "\n{}", bad.join("\n"));
    }

    #[test]
    fn an_edited_copy_of_an_exempt_migration_is_no_longer_exempt() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("supabase").join("migrations");
        for (name, _) in EXTENSION_EXEMPT {
            let sql = std::fs::read_to_string(dir.join(name)).unwrap();
            assert!(extension_exempt(name, &sql), "{name} as committed");
            assert!(extension_exempt(name, &sql.replace("\r\n", "\n").replace('\n', "\r\n")), "{name} with CRLF");
            assert!(!extension_exempt(name, &format!("{sql}\n-- x")), "{name} edited");
            assert!(!extension_exempt("other.sql", &sql), "{name} under another name");
        }
    }
}
