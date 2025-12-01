// FilterToQueryConverter - NIP-01フィルターをOpenSearch Query DSLに変換
//
// nostr::FilterからOpenSearch bool queryを生成する。
// OpenSearchEventRepositoryの内部実装として、フィルター変換ロジックをカプセル化。
//
// 要件: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8

use nostr::Filter;
use serde_json::{json, Value};

/// フィルターからOpenSearchクエリへの変換
///
/// OpenSearchEventRepositoryモジュール内の内部実装。
/// NIP-01フィルター条件をOpenSearch Query DSLに変換する責務を持つ。
///
/// # 変換ルール
/// - 複数フィルターオブジェクト: OR結合（bool.should）
/// - 単一フィルター内の複数条件: AND結合（bool.filter）
/// - 空のフィルター配列: match_all
///
/// # フィルター変換
/// - ids: terms query（完全一致）
/// - authors: terms query（完全一致）
/// - kinds: terms query
/// - since/until: range query
/// - #タグ: 対応するtag_{letter}フィールドのterms query
///
/// # 注意: 前方一致検索について
/// NIP-01ではids/authorsの前方一致検索がオプショナルでサポートされているが、
/// nostrクレートのEventId/PublicKey型は64文字の完全なhex文字列のみを受け付けるため、
/// 本実装では完全一致検索のみをサポートする。
pub(super) struct FilterToQueryConverter;

impl FilterToQueryConverter {
    /// 複数フィルターをOpenSearchクエリJSONに変換
    ///
    /// フィルターが空の場合はmatch_allクエリを返す。
    /// 複数フィルターはORで結合（bool.should）。
    ///
    /// # 引数
    /// * `filters` - NIP-01フィルター配列
    ///
    /// # 戻り値
    /// OpenSearch Query DSL JSON
    ///
    /// 要件: 4.7, 4.8
    pub fn convert(filters: &[Filter]) -> Value {
        // 空のフィルター配列はmatch_allクエリを返す
        if filters.is_empty() {
            return json!({
                "match_all": {}
            });
        }

        // 単一フィルターの場合はシンプルな形式
        if filters.len() == 1 {
            return Self::convert_single_filter(&filters[0]);
        }

        // 複数フィルターはORで結合（bool.should）
        // minimum_should_match: 1 で少なくとも1つにマッチすることを要求
        let should_clauses: Vec<Value> = filters
            .iter()
            .map(Self::convert_single_filter)
            .collect();

        json!({
            "bool": {
                "should": should_clauses,
                "minimum_should_match": 1
            }
        })
    }

    /// 単一フィルターをbool query clauseに変換
    ///
    /// フィルター内の複数条件はANDで結合（bool.filter）。
    /// filter句を使用してスコア計算をスキップしパフォーマンスを向上。
    ///
    /// # 引数
    /// * `filter` - 単一のNIP-01フィルター
    ///
    /// # 戻り値
    /// OpenSearch Query DSL JSON
    ///
    /// 要件: 4.1-4.6, 4.7
    fn convert_single_filter(filter: &Filter) -> Value {
        let mut filter_clauses: Vec<Value> = Vec::new();

        // idsフィルター (要件 4.1)
        if let Some(ids) = &filter.ids
            && let Some(query) = Self::build_ids_query(ids)
        {
            filter_clauses.push(query);
        }

        // authorsフィルター (要件 4.2)
        if let Some(authors) = &filter.authors
            && let Some(query) = Self::build_authors_query(authors)
        {
            filter_clauses.push(query);
        }

        // kindsフィルター (要件 4.3)
        if let Some(kinds) = &filter.kinds
            && let Some(query) = Self::build_kinds_query(kinds)
        {
            filter_clauses.push(query);
        }

        // since/untilフィルター (要件 4.4, 4.5)
        if let Some(query) = Self::build_time_range_query(filter.since, filter.until) {
            filter_clauses.push(query);
        }

        // タグフィルター (要件 4.6)
        for (tag, values) in &filter.generic_tags {
            // 英字1文字タグのみサポート
            let tag_char = tag.as_char();
            if tag_char.is_ascii_alphabetic()
                && let Some(query) = Self::build_tag_query(tag_char, values)
            {
                filter_clauses.push(query);
            }
        }

        // filter句が空の場合はmatch_all
        if filter_clauses.is_empty() {
            return json!({
                "match_all": {}
            });
        }

        // filter句を使用してスコア計算をスキップ
        json!({
            "bool": {
                "filter": filter_clauses
            }
        })
    }

    /// idsフィルターをterms queryに変換
    ///
    /// nostrクレートのEventId型は64文字の完全なhex文字列のみを受け付けるため、
    /// 完全一致検索のみをサポートする。
    ///
    /// # 引数
    /// * `ids` - イベントIDのセット
    ///
    /// # 戻り値
    /// OpenSearch Query DSL JSON（空の場合はNone）
    ///
    /// 要件: 4.1
    fn build_ids_query(ids: &std::collections::BTreeSet<nostr::EventId>) -> Option<Value> {
        if ids.is_empty() {
            return None;
        }

        let id_values: Vec<String> = ids.iter().map(|id| id.to_hex()).collect();

        Some(json!({
            "terms": {
                "id": id_values
            }
        }))
    }

    /// authorsフィルターをterms queryに変換
    ///
    /// nostrクレートのPublicKey型は64文字の完全なhex文字列のみを受け付けるため、
    /// 完全一致検索のみをサポートする。
    ///
    /// # 引数
    /// * `authors` - 公開鍵のセット
    ///
    /// # 戻り値
    /// OpenSearch Query DSL JSON（空の場合はNone）
    ///
    /// 要件: 4.2
    fn build_authors_query(authors: &std::collections::BTreeSet<nostr::PublicKey>) -> Option<Value> {
        if authors.is_empty() {
            return None;
        }

        let pubkey_values: Vec<String> = authors.iter().map(|pk| pk.to_hex()).collect();

        Some(json!({
            "terms": {
                "pubkey": pubkey_values
            }
        }))
    }

    /// kindsフィルターをterms queryに変換
    ///
    /// # 引数
    /// * `kinds` - イベント種別のセット
    ///
    /// # 戻り値
    /// OpenSearch Query DSL JSON（空の場合はNone）
    ///
    /// 要件: 4.3
    fn build_kinds_query(kinds: &std::collections::BTreeSet<nostr::Kind>) -> Option<Value> {
        if kinds.is_empty() {
            return None;
        }

        let kind_values: Vec<u16> = kinds.iter().map(|k| k.as_u16()).collect();

        Some(json!({
            "terms": {
                "kind": kind_values
            }
        }))
    }

    /// since/untilをrange queryに変換
    ///
    /// # 引数
    /// * `since` - 開始時刻（created_at >= since）
    /// * `until` - 終了時刻（created_at <= until）
    ///
    /// # 戻り値
    /// OpenSearch Query DSL JSON（両方Noneの場合はNone）
    ///
    /// 要件: 4.4, 4.5
    fn build_time_range_query(
        since: Option<nostr::Timestamp>,
        until: Option<nostr::Timestamp>,
    ) -> Option<Value> {
        if since.is_none() && until.is_none() {
            return None;
        }

        let mut range = serde_json::Map::new();

        if let Some(since_ts) = since {
            range.insert("gte".to_string(), json!(since_ts.as_secs()));
        }

        if let Some(until_ts) = until {
            range.insert("lte".to_string(), json!(until_ts.as_secs()));
        }

        Some(json!({
            "range": {
                "created_at": range
            }
        }))
    }

    /// タグフィルターをterms queryに変換
    ///
    /// # 引数
    /// * `tag_char` - タグ文字（e, p, d等）
    /// * `values` - タグ値のセット
    ///
    /// # 戻り値
    /// OpenSearch Query DSL JSON（空の場合はNone）
    ///
    /// 要件: 4.6
    fn build_tag_query(
        tag_char: char,
        values: &std::collections::BTreeSet<String>,
    ) -> Option<Value> {
        if values.is_empty() {
            return None;
        }

        let field_name = format!("tag_{}", tag_char.to_ascii_lowercase());
        let tag_values: Vec<&str> = values.iter().map(|v| v.as_str()).collect();

        Some(json!({
            "terms": {
                field_name: tag_values
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventId, Filter, Kind, PublicKey, Timestamp};

    // ==================== Task 5.1: 基本フィルター変換テスト ====================

    // --- idsフィルターテスト (要件 4.1) ---

    #[test]
    fn test_ids_filter_exact_match_64_chars() {
        // 64文字のIDは完全一致（terms query）
        let id_hex = "a".repeat(64);
        let event_id = EventId::from_hex(&id_hex).unwrap();
        let filter = Filter::new().id(event_id);

        let query = FilterToQueryConverter::convert(&[filter]);

        // bool.filterの中にterms queryがあることを確認
        let filter_clauses = &query["bool"]["filter"];
        assert!(filter_clauses.is_array());

        let terms_query = &filter_clauses[0];
        assert!(terms_query["terms"]["id"].is_array());
        assert_eq!(terms_query["terms"]["id"][0].as_str().unwrap(), id_hex);
    }

    #[test]
    fn test_ids_filter_multiple_exact_match() {
        // 複数の64文字IDは1つのterms queryにまとめられる
        let id1 = "a".repeat(64);
        let id2 = "b".repeat(64);
        let event_id1 = EventId::from_hex(&id1).unwrap();
        let event_id2 = EventId::from_hex(&id2).unwrap();
        let filter = Filter::new().ids([event_id1, event_id2]);

        let query = FilterToQueryConverter::convert(&[filter]);

        let filter_clauses = &query["bool"]["filter"];
        let terms_query = &filter_clauses[0];
        let ids = terms_query["terms"]["id"].as_array().unwrap();
        assert_eq!(ids.len(), 2);
    }

    // --- authorsフィルターテスト (要件 4.2) ---

    #[test]
    fn test_authors_filter_exact_match_64_chars() {
        // 64文字のpubkeyは完全一致（terms query）
        let pubkey_hex = "a".repeat(64);
        let pubkey = PublicKey::from_hex(&pubkey_hex).unwrap();
        let filter = Filter::new().author(pubkey);

        let query = FilterToQueryConverter::convert(&[filter]);

        let filter_clauses = &query["bool"]["filter"];
        let terms_query = &filter_clauses[0];
        assert!(terms_query["terms"]["pubkey"].is_array());
        assert_eq!(
            terms_query["terms"]["pubkey"][0].as_str().unwrap(),
            pubkey_hex
        );
    }

    #[test]
    fn test_authors_filter_multiple_exact_match() {
        // 複数の64文字pubkeyは1つのterms queryにまとめられる
        let key1 = "a".repeat(64);
        let key2 = "b".repeat(64);
        let pubkey1 = PublicKey::from_hex(&key1).unwrap();
        let pubkey2 = PublicKey::from_hex(&key2).unwrap();
        let filter = Filter::new().authors([pubkey1, pubkey2]);

        let query = FilterToQueryConverter::convert(&[filter]);

        let filter_clauses = &query["bool"]["filter"];
        let terms_query = &filter_clauses[0];
        let pubkeys = terms_query["terms"]["pubkey"].as_array().unwrap();
        assert_eq!(pubkeys.len(), 2);
    }

    // --- kindsフィルターテスト (要件 4.3) ---

    #[test]
    fn test_kinds_filter_single_kind() {
        // 単一のkindはterms queryに変換される
        let filter = Filter::new().kind(Kind::TextNote);

        let query = FilterToQueryConverter::convert(&[filter]);

        let filter_clauses = &query["bool"]["filter"];
        let terms_query = &filter_clauses[0];
        assert!(terms_query["terms"]["kind"].is_array());
        assert_eq!(terms_query["terms"]["kind"][0].as_u64().unwrap(), 1);
    }

    #[test]
    fn test_kinds_filter_multiple_kinds() {
        // 複数のkindは1つのterms queryにまとめられる
        let filter = Filter::new().kinds([Kind::TextNote, Kind::Metadata, Kind::ContactList]);

        let query = FilterToQueryConverter::convert(&[filter]);

        let filter_clauses = &query["bool"]["filter"];
        let terms_query = &filter_clauses[0];
        let kinds = terms_query["terms"]["kind"].as_array().unwrap();
        assert_eq!(kinds.len(), 3);
    }

    // ==================== Task 5.2: 時間範囲とタグフィルター変換テスト ====================

    // --- sinceフィルターテスト (要件 4.4) ---

    #[test]
    fn test_since_filter() {
        // sinceはrange query (gte)に変換される
        let since_ts = Timestamp::from_secs(1700000000);
        let filter = Filter::new().since(since_ts);

        let query = FilterToQueryConverter::convert(&[filter]);

        let filter_clauses = &query["bool"]["filter"];
        let range_query = &filter_clauses[0];
        assert_eq!(
            range_query["range"]["created_at"]["gte"].as_u64().unwrap(),
            1700000000
        );
    }

    // --- untilフィルターテスト (要件 4.5) ---

    #[test]
    fn test_until_filter() {
        // untilはrange query (lte)に変換される
        let until_ts = Timestamp::from_secs(1800000000);
        let filter = Filter::new().until(until_ts);

        let query = FilterToQueryConverter::convert(&[filter]);

        let filter_clauses = &query["bool"]["filter"];
        let range_query = &filter_clauses[0];
        assert_eq!(
            range_query["range"]["created_at"]["lte"].as_u64().unwrap(),
            1800000000
        );
    }

    #[test]
    fn test_since_and_until_filter() {
        // since + untilは両方の条件を持つrange queryに変換される
        let since_ts = Timestamp::from_secs(1700000000);
        let until_ts = Timestamp::from_secs(1800000000);
        let filter = Filter::new().since(since_ts).until(until_ts);

        let query = FilterToQueryConverter::convert(&[filter]);

        let filter_clauses = &query["bool"]["filter"];
        let range_query = &filter_clauses[0];
        assert_eq!(
            range_query["range"]["created_at"]["gte"].as_u64().unwrap(),
            1700000000
        );
        assert_eq!(
            range_query["range"]["created_at"]["lte"].as_u64().unwrap(),
            1800000000
        );
    }

    // --- タグフィルターテスト (要件 4.6) ---

    #[test]
    fn test_e_tag_filter() {
        // #eタグはtag_eフィールドのterms queryに変換される
        let event_id_hex = "a".repeat(64);
        let filter = Filter::new().custom_tag(
            nostr::SingleLetterTag::lowercase(nostr::Alphabet::E),
            event_id_hex.clone(),
        );

        let query = FilterToQueryConverter::convert(&[filter]);

        let filter_clauses = &query["bool"]["filter"];
        let terms_query = &filter_clauses[0];
        assert!(terms_query["terms"]["tag_e"].is_array());
        assert_eq!(
            terms_query["terms"]["tag_e"][0].as_str().unwrap(),
            event_id_hex
        );
    }

    #[test]
    fn test_p_tag_filter() {
        // #pタグはtag_pフィールドのterms queryに変換される
        let pubkey_hex = "b".repeat(64);
        let filter = Filter::new().custom_tag(
            nostr::SingleLetterTag::lowercase(nostr::Alphabet::P),
            pubkey_hex.clone(),
        );

        let query = FilterToQueryConverter::convert(&[filter]);

        let filter_clauses = &query["bool"]["filter"];
        let terms_query = &filter_clauses[0];
        assert!(terms_query["terms"]["tag_p"].is_array());
        assert_eq!(
            terms_query["terms"]["tag_p"][0].as_str().unwrap(),
            pubkey_hex
        );
    }

    #[test]
    fn test_d_tag_filter() {
        // #dタグはtag_dフィールドのterms queryに変換される
        let identifier = "my-article";
        let filter = Filter::new().custom_tag(
            nostr::SingleLetterTag::lowercase(nostr::Alphabet::D),
            identifier.to_string(),
        );

        let query = FilterToQueryConverter::convert(&[filter]);

        let filter_clauses = &query["bool"]["filter"];
        let terms_query = &filter_clauses[0];
        assert!(terms_query["terms"]["tag_d"].is_array());
        assert_eq!(
            terms_query["terms"]["tag_d"][0].as_str().unwrap(),
            identifier
        );
    }

    #[test]
    fn test_t_tag_filter() {
        // #tタグはtag_tフィールドのterms queryに変換される
        let hashtag = "nostr";
        let filter = Filter::new().custom_tag(
            nostr::SingleLetterTag::lowercase(nostr::Alphabet::T),
            hashtag.to_string(),
        );

        let query = FilterToQueryConverter::convert(&[filter]);

        let filter_clauses = &query["bool"]["filter"];
        let terms_query = &filter_clauses[0];
        assert!(terms_query["terms"]["tag_t"].is_array());
        assert_eq!(terms_query["terms"]["tag_t"][0].as_str().unwrap(), hashtag);
    }

    #[test]
    fn test_multiple_tag_values() {
        // 複数のタグ値は1つのterms queryにまとめられる
        let filter = Filter::new()
            .custom_tag(
                nostr::SingleLetterTag::lowercase(nostr::Alphabet::T),
                "tag1".to_string(),
            )
            .custom_tag(
                nostr::SingleLetterTag::lowercase(nostr::Alphabet::T),
                "tag2".to_string(),
            );

        let query = FilterToQueryConverter::convert(&[filter]);

        let filter_clauses = &query["bool"]["filter"];
        let terms_query = &filter_clauses[0];
        let tags = terms_query["terms"]["tag_t"].as_array().unwrap();
        assert_eq!(tags.len(), 2);
    }

    // ==================== Task 5.3: 複数フィルター条件の結合テスト ====================

    // --- 単一フィルター内の複数条件（ANDで結合） (要件 4.7) ---

    #[test]
    fn test_single_filter_multiple_conditions_and() {
        // 単一フィルター内の複数条件はANDで結合（bool.filter）
        let pubkey_hex = "a".repeat(64);
        let pubkey = PublicKey::from_hex(&pubkey_hex).unwrap();
        let filter = Filter::new()
            .author(pubkey)
            .kind(Kind::TextNote)
            .since(Timestamp::from_secs(1700000000));

        let query = FilterToQueryConverter::convert(&[filter]);

        // bool.filterの中に複数のクエリがあることを確認
        let filter_clauses = &query["bool"]["filter"];
        assert!(filter_clauses.is_array());
        assert_eq!(filter_clauses.as_array().unwrap().len(), 3);
    }

    #[test]
    fn test_filter_clause_used_for_no_scoring() {
        // filter句が使用されていることを確認（スコア計算なし）
        let filter = Filter::new().kind(Kind::TextNote);

        let query = FilterToQueryConverter::convert(&[filter]);

        // "filter"キーが使用されていることを確認（"must"ではない）
        assert!(query["bool"]["filter"].is_array());
        assert!(query["bool"]["must"].is_null());
    }

    // --- 複数フィルターオブジェクト（ORで結合） (要件 4.8) ---

    #[test]
    fn test_multiple_filters_or() {
        // 複数フィルターはORで結合（bool.should）
        let filter1 = Filter::new().kind(Kind::TextNote);
        let filter2 = Filter::new().kind(Kind::Metadata);

        let query = FilterToQueryConverter::convert(&[filter1, filter2]);

        // bool.shouldが使用されていることを確認
        let should_clauses = &query["bool"]["should"];
        assert!(should_clauses.is_array());
        assert_eq!(should_clauses.as_array().unwrap().len(), 2);

        // minimum_should_match: 1が設定されていることを確認
        assert_eq!(query["bool"]["minimum_should_match"].as_u64().unwrap(), 1);
    }

    // --- 空のフィルター配列 ---

    #[test]
    fn test_empty_filters_match_all() {
        // 空のフィルター配列はmatch_all queryを返す
        let query = FilterToQueryConverter::convert(&[]);

        assert!(query["match_all"].is_object());
    }

    #[test]
    fn test_empty_filter_object_match_all() {
        // 条件のないフィルターオブジェクトはmatch_allを返す
        let filter = Filter::new();

        let query = FilterToQueryConverter::convert(&[filter]);

        assert!(query["match_all"].is_object());
    }

    // --- 複雑な結合テスト ---

    #[test]
    fn test_complex_filter_combination() {
        // 複数のフィルター、それぞれ複数条件を持つ場合
        let pubkey_hex = "a".repeat(64);
        let pubkey = PublicKey::from_hex(&pubkey_hex).unwrap();

        // Filter 1: author + kind + since
        let filter1 = Filter::new()
            .author(pubkey)
            .kind(Kind::TextNote)
            .since(Timestamp::from_secs(1700000000));

        // Filter 2: kind + #e tag
        let event_id_hex = "b".repeat(64);
        let filter2 = Filter::new()
            .kind(Kind::Repost)
            .custom_tag(
                nostr::SingleLetterTag::lowercase(nostr::Alphabet::E),
                event_id_hex,
            );

        let query = FilterToQueryConverter::convert(&[filter1, filter2]);

        // 全体構造: bool.should で2つのフィルターがOR結合
        let should_clauses = &query["bool"]["should"];
        assert!(should_clauses.is_array());
        assert_eq!(should_clauses.as_array().unwrap().len(), 2);

        // 各フィルター内はbool.filterでAND結合
        let filter1_query = &should_clauses[0];
        assert!(filter1_query["bool"]["filter"].is_array());

        let filter2_query = &should_clauses[1];
        assert!(filter2_query["bool"]["filter"].is_array());
    }

    // --- 単一フィルター最適化テスト ---

    #[test]
    fn test_single_filter_no_extra_wrapping() {
        // 単一フィルターの場合、余分なshould/minimum_should_matchでラップしない
        let filter = Filter::new().kind(Kind::TextNote);

        let query = FilterToQueryConverter::convert(&[filter]);

        // 単一フィルターはbool.filterで直接変換される
        assert!(query["bool"]["filter"].is_array());
        // shouldでラップされていないことを確認
        assert!(query["bool"]["should"].is_null());
    }

    // ==================== ヘルパーメソッドの個別テスト ====================

    #[test]
    fn test_build_kinds_query_empty() {
        // 空のkindsはNoneを返す
        let kinds = std::collections::BTreeSet::new();
        let result = FilterToQueryConverter::build_kinds_query(&kinds);
        assert!(result.is_none());
    }

    #[test]
    fn test_build_time_range_query_none() {
        // 両方Noneの場合はNoneを返す
        let result = FilterToQueryConverter::build_time_range_query(None, None);
        assert!(result.is_none());
    }

    #[test]
    fn test_build_time_range_query_only_since() {
        // sinceのみ指定
        let since = Some(Timestamp::from_secs(1700000000));
        let result = FilterToQueryConverter::build_time_range_query(since, None);

        assert!(result.is_some());
        let query = result.unwrap();
        assert_eq!(query["range"]["created_at"]["gte"].as_u64().unwrap(), 1700000000);
        assert!(query["range"]["created_at"]["lte"].is_null());
    }

    #[test]
    fn test_build_time_range_query_only_until() {
        // untilのみ指定
        let until = Some(Timestamp::from_secs(1800000000));
        let result = FilterToQueryConverter::build_time_range_query(None, until);

        assert!(result.is_some());
        let query = result.unwrap();
        assert!(query["range"]["created_at"]["gte"].is_null());
        assert_eq!(query["range"]["created_at"]["lte"].as_u64().unwrap(), 1800000000);
    }
}
