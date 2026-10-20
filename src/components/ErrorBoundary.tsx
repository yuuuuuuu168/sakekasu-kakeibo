import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorMessage } from '../lib/errors';
import { Notice } from './ui/Notice';

/**
 * 画面の描画で例外が出たときの受け口。無いと React は画面ごと消し、白い画面だけが残る。
 * 上部のタブは外に置いてあるので、別の画面へ移れば作り直される（App が key を付ける）
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: unknown }> {
  state: { error?: unknown } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (this.state.error === undefined) return this.props.children;
    return (
      <Notice tone="error">
        この画面を表示できませんでした。{errorMessage(this.state.error)}
        <br />
        別のタブに移るか、ページを読み込み直してください。
      </Notice>
    );
  }
}
