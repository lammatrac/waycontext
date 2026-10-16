-- Full-text query that matches ANY of the query's words, not all of them.
--
-- plainto_tsquery ANDs every word, so a plain-language search_code query of
-- eight or ten words ("comparison table filter categories tags hide empty
-- ...") matched only a symbol containing every one of them -- in practice
-- none, and the full-text half of hybrid search returned nothing. OR-ing the
-- words and letting ts_rank order the hits rewards symbols that match more of
-- them, which is what a description-style query wants.
--
-- English stopwords are dropped first ("with", "for", "the" match nearly every
-- body under the 'simple' config, so OR-ing them in would rank on noise). A
-- word counts as a stopword when the 'english' config reduces it to nothing.
-- If the query is nothing but stopwords, fall back to the AND query so it
-- still means what it says.
--
-- Each word is re-parsed through plainto_tsquery rather than quoted by hand, so
-- a lexeme carrying punctuation (foo.php, a-b) stays valid tsquery syntax; the
-- parentheses keep a lexeme that re-parses into two terms an AND inside the OR.

CREATE OR REPLACE FUNCTION wc_any_tsquery(q text) RETURNS tsquery
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    (SELECT string_agg('(' || plainto_tsquery('simple', w)::text || ')', ' | ')::tsquery
       FROM unnest(tsvector_to_array(to_tsvector('simple', q))) AS w
      WHERE to_tsvector('english', w) <> ''::tsvector),
    plainto_tsquery('simple', q)
  )
$$;
