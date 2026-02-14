use crate::database::models::AiSummaryRow;
use chrono::Utc;
use sqlx::SqlitePool;
use tracing::info;
use uuid::Uuid;

pub struct AiSummaryRepository;

impl AiSummaryRepository {
    /// Save or replace the latest summary for a meeting (one row per meeting).
    pub async fn save_summary(
        pool: &SqlitePool,
        meeting_id: &str,
        summary_text: &str,
        provider: &str,
        model: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();

        sqlx::query(
            r#"
            INSERT INTO summaries (id, meeting_id, summary_text, provider, model, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(meeting_id)
        .bind(summary_text)
        .bind(provider)
        .bind(model)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;

        info!(
            "Saved AI summary for meeting_id: {} provider: {}",
            meeting_id, provider
        );
        Ok(())
    }

    /// Get the latest summary for a meeting (most recent by updated_at).
    pub async fn get_summary(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<AiSummaryRow>, sqlx::Error> {
        sqlx::query_as::<_, AiSummaryRow>(
            "SELECT * FROM summaries WHERE meeting_id = ? ORDER BY updated_at DESC LIMIT 1",
        )
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
    }

    /// Update the latest summary for a meeting (updates the most recent row).
    pub async fn update_summary(
        pool: &SqlitePool,
        meeting_id: &str,
        new_summary_text: &str,
    ) -> Result<bool, sqlx::Error> {
        let now = Utc::now();
        let result = sqlx::query(
            "UPDATE summaries SET summary_text = ?, updated_at = ? WHERE meeting_id = ?",
        )
        .bind(new_summary_text)
        .bind(now)
        .bind(meeting_id)
        .execute(pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }
}
