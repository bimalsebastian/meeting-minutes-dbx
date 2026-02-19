-- Add databricks_workspace_url column to settings table for persistence
ALTER TABLE settings ADD COLUMN databricks_workspace_url TEXT;
