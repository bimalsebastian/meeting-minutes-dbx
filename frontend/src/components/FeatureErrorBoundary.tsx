'use client';

import React from 'react';

interface Props {
  name: string;
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class FeatureErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error) {
    console.error(`[FeatureErrorBoundary] ${this.props.name} crashed:`, error);
  }

  render() {
    if (this.state.hasError) {
      // Silent null — the feature is unavailable but the rest of the app works
      return null;
    }
    return this.props.children;
  }
}
