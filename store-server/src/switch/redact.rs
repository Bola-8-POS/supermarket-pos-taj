//! pg tools quote the offending row in `COPY ... CONTEXT` lines and a row can hold a plaintext staff PIN.
//! Keep the first few error lines, drop the quoting lines, mask any run of four or more digits, cap the length.
fn flush(out: &mut String, run: &mut String) {
    if run.len() >= 4 {
        out.push_str("####");
    } else {
        out.push_str(run);
    }
    run.clear();
}

fn mask_digits(s: &str) -> String {
    let (mut out, mut run) = (String::new(), String::new());
    for c in s.chars() {
        if c.is_ascii_digit() {
            run.push(c);
        } else {
            flush(&mut out, &mut run);
            out.push(c);
        }
    }
    flush(&mut out, &mut run);
    out
}

fn is_identifier(s: &str) -> bool {
    let mut it = s.chars();
    matches!(it.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && it.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

/// Quoted text that is not identifier-shaped can be a row value: replace it. An unterminated quote masks the rest.
fn mask_quoted(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find(['"', '\'']) {
        let q = rest[i..].chars().next().unwrap_or('"');
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find(q) {
            Some(j) if is_identifier(&after[..j]) => {
                out.push(q);
                out.push_str(&after[..j]);
                out.push(q);
                rest = &after[j + 1..];
            }
            Some(j) => {
                out.push_str("\"…\"");
                rest = &after[j + 1..];
            }
            None => {
                out.push_str("\"…\"");
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

const TOOLS: [&str; 3] = ["pg_dump:", "pg_restore:", "psql:"];
const QUOTING: [&str; 8] = [
    "context:",
    "detail:",
    "command was:",
    "query:",
    "query was:",
    "hint:",
    "where:",
    "statement:",
];

/// `ERROR:  57014` (psql with `-v VERBOSITY=sqlstate`): five characters of class+code, never row data. The digit mask would
/// turn an all-digit code into `####` and callers (and the person reading the envelope) need the code.
fn is_sqlstate_line(t: &str) -> bool {
    let l = t.to_ascii_lowercase();
    let l = TOOLS
        .iter()
        .find(|p| l.starts_with(**p))
        .map_or(l.as_str(), |p| l[p.len()..].trim_start());
    match l.strip_prefix("error:") {
        Some(code) => {
            let code = code.trim();
            code.len() == 5 && code.bytes().all(|b| b.is_ascii_alphanumeric())
        }
        None => false,
    }
}

pub fn redact_pg_stderr(raw: &str) -> String {
    let mut kept: Vec<String> = vec![];
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let mut l = t.to_ascii_lowercase();
        if let Some(p) = TOOLS.iter().find(|p| l.starts_with(**p)) {
            l = l[p.len()..].trim_start().to_string();
        }
        let quoting = QUOTING.iter().any(|p| l.starts_with(p))
            || l.starts_with("line ")
            || (l.contains("copy ") && l.contains(" line "));
        if quoting {
            continue;
        }
        if is_sqlstate_line(t) {
            kept.push(t.to_string());
        } else {
            kept.push(mask_digits(&mask_quoted(t)));
        }
        if kept.len() >= 4 {
            break;
        }
    }
    let joined = kept.join(" | ");
    if joined.chars().count() > 300 {
        joined.chars().take(300).collect()
    } else {
        joined
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_copy_error_keeps_the_error_line_and_drops_the_quoted_row() {
        let digits = ["12", "34", "56"].concat();
        let raw = format!("pg_restore: error: COPY failed for table \"profiles\": ERROR:  new row violates check constraint \"pin_numeric\"\nDETAIL:  Failing row contains (abc, Ana, admin, {digits}).\nCONTEXT:  COPY profiles, line 3: \"abc\tAna\tadmin\t{digits}\"\npg_restore: warning: errors ignored on restore: 1\n");
        let out = redact_pg_stderr(&raw);
        assert!(out.contains("COPY failed for table"), "{out}");
        assert!(
            !out.contains(&digits) && !out.contains("Failing row") && !out.contains("CONTEXT"),
            "{out}"
        );
    }

    #[test]
    fn long_digit_runs_are_masked_and_the_result_is_short() {
        let out = redact_pg_stderr(&format!(
            "error near {}\n",
            ["9", "8", "7", "6", "5", "4"].concat()
        ));
        assert!(!out.contains("987654") && out.contains("####"));
        assert!(redact_pg_stderr(&"x".repeat(900)).chars().count() <= 300);
        assert_eq!(redact_pg_stderr(""), "");
    }

    #[test]
    fn a_bare_sqlstate_survives_the_digit_mask() {
        for code in ["57014", "55P03", "PS001", "25006"] {
            let out = redact_pg_stderr(&format!("ERROR:  {code}\n"));
            assert_eq!(out, format!("ERROR:  {code}"), "{code}");
        }
        // a longer all-digit token after ERROR: is still masked
        let long = ["9", "8", "7", "6", "5", "4"].concat();
        assert!(!redact_pg_stderr(&format!("ERROR:  {long}\n")).contains(&long));
    }

    #[test]
    fn short_numbers_such_as_line_counts_survive() {
        assert!(redact_pg_stderr("pg_dump: error: query failed on table 12\n").contains("12"));
    }

    #[test]
    fn the_digit_mask_starts_at_exactly_four_digits() {
        let three = ["1", "2", "3"].concat();
        let four = ["1", "2", "3", "4"].concat();
        assert!(redact_pg_stderr(&format!("n {three} m")).contains(&three));
        let out = redact_pg_stderr(&format!("n {four} m"));
        assert!(!out.contains(&four) && out.contains("n #### m"), "{out}");
    }

    #[test]
    fn a_tool_prefix_does_not_hide_a_quoting_line() {
        let raw = "pg_dump: error: query failed: ERROR:  boom\npg_dump: detail: Query was: SELECT pin FROM profiles\npsql: hint: try x\npg_restore: context: COPY a, line 1: \"x\"\n";
        let out = redact_pg_stderr(raw);
        assert!(out.contains("boom"), "{out}");
        for gone in ["SELECT", "Query was", "try x", "COPY"] {
            assert!(!out.contains(gone), "{gone}: {out}");
        }
    }

    #[test]
    fn query_hint_where_statement_and_command_was_lines_are_dropped() {
        let raw = "error: first\nQUERY:  SELECT secret_col\nHINT:  do the thing\nWHERE:  PL/pgSQL function f()\nSTATEMENT:  INSERT INTO t VALUES (x)\ncommand was: COPY public.t TO stdout\npg_dump: STATEMENT:  again\nerror: last\n";
        let out = redact_pg_stderr(raw);
        assert_eq!(out, "error: first | error: last");
    }

    #[test]
    fn quoted_text_that_is_not_an_identifier_is_masked_and_identifiers_survive() {
        let out = redact_pg_stderr("ERROR:  invalid input syntax for type integer: \"Ana Lopez\" in \"public.profiles\" col 'free text' or 'role_x'\n");
        assert!(
            !out.contains("Ana Lopez") && !out.contains("free text"),
            "{out}"
        );
        assert!(
            out.contains("\"public.profiles\"")
                && out.contains("'role_x'")
                && out.contains("\"…\""),
            "{out}"
        );
        let open = redact_pg_stderr("ERROR: bad value \"unterminated secret words");
        assert!(!open.contains("secret words"), "{open}");
    }

    #[test]
    fn at_most_four_lines_are_kept() {
        let raw = "err a\nerr b\nerr c\nerr d\nerr e\nerr f\n";
        let out = redact_pg_stderr(raw);
        assert_eq!(out, "err a | err b | err c | err d");
    }

    #[test]
    fn a_command_was_line_is_dropped_on_its_own() {
        let out =
            redact_pg_stderr("pg_dump: error: failed\ncommand was: COPY secret_table TO stdout\n");
        assert_eq!(out, "pg_dump: error: failed");
    }

    #[test]
    fn a_query_was_line_is_dropped_on_its_own() {
        let out = redact_pg_stderr("error: failed\nquery was: SELECT leak FROM t\n");
        assert_eq!(out, "error: failed");
    }

    #[test]
    fn a_line_n_line_is_dropped_on_its_own() {
        let out = redact_pg_stderr("error: failed\nline 3: leaked row text\n");
        assert_eq!(out, "error: failed");
    }

    #[test]
    fn a_context_line_is_dropped_on_its_own() {
        // "context: leaked" has no `copy ` and no ` line `, so only the `context:` rule can drop it.
        let out = redact_pg_stderr("error: failed\ncontext: leaked row text\n");
        assert_eq!(out, "error: failed");
    }
}
