#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct Timestamp(i64);

impl Timestamp {
    /// 内部のi64値を返す
    pub fn as_i64(&self) -> i64 {
        self.0
    }
}
