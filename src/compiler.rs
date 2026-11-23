//! Compile Overpass and validate GOQL with the same parsers used for execution.
use regol::{Error, Query};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(untagged)]
pub enum CompileRequest {
    Overpass {
        text: String,
        viewport: Option<Vec<[f64; 4]>>,
    },
    Goql {
        selectors: Vec<String>,
    },
}

impl CompileRequest {
    pub fn compile(self) -> Result<Value, String> {
        match self {
            Self::Overpass { text, viewport } => {
                regol_overpass::compiler::compile(&text, viewport.as_deref())
            }
            Self::Goql { selectors } => {
                for (index, selector) in selectors.iter().enumerate() {
                    match Query::parse(selector) {
                        Ok(_) => {}
                        Err(Error::Query { offset, message }) => {
                            return Ok(
                                json!({ "index": index, "offset": offset, "message": message }),
                            );
                        }
                        Err(error) => return Err(error.to_string()),
                    }
                }
                Ok(Value::Null)
            }
        }
    }
}
