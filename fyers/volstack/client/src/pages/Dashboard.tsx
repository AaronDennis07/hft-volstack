import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { tradingService } from '../services/api';

interface StrategyStatus {
  running: boolean;
  lastFetch?: string;
  symbol: string;
  totalCandles?: number;
  firstCandle?: string;
  lastCandle?: string;
}

export const Dashboard = () => {
  const { user } = useAuth();
  const [strategyStatus, setStrategyStatus] = useState<StrategyStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchStrategyStatus = async () => {
    try {
      const status = await tradingService.getStrategyStatus();
      setStrategyStatus(status);
    } catch (error) {
      console.error('Failed to fetch strategy status:', error);
    }
  };

  useEffect(() => {
    fetchStrategyStatus();
    const interval = setInterval(fetchStrategyStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleStartStrategy = async () => {
    setLoading(true);
    try {
      await tradingService.startStrategy();
      await fetchStrategyStatus();
    } catch (error) {
      console.error('Failed to start strategy:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleStopStrategy = async () => {
    setLoading(true);
    try {
      await tradingService.stopStrategy();
      await fetchStrategyStatus();
    } catch (error) {
      console.error('Failed to stop strategy:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Welcome Card */}
      <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-2xl shadow-xl p-8 mb-8 text-white">
        <h2 className="text-3xl font-bold mb-2">Welcome back, {user?.name || 'Trader'}! 👋</h2>
        <p className="text-blue-100">Monitor your trading strategy and manage your data collection</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Strategy Control Card */}
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-lg p-6 border border-gray-100">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-gray-900">Strategy Control</h2>
            <div className={`flex items-center space-x-2 px-4 py-2 rounded-full ${strategyStatus?.running ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
              <div className={`h-2 w-2 rounded-full ${strategyStatus?.running ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`}></div>
              <span className="text-sm font-semibold">{strategyStatus?.running ? 'Running' : 'Stopped'}</span>
            </div>
          </div>
          
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl border border-blue-200">
                <p className="text-sm text-blue-600 font-medium mb-1">Symbol</p>
                <p className="text-xl font-bold text-blue-900">{strategyStatus?.symbol || 'NSE:NIFTY50-INDEX'}</p>
              </div>

              <div className="p-4 bg-gradient-to-br from-purple-50 to-purple-100 rounded-xl border border-purple-200">
                <p className="text-sm text-purple-600 font-medium mb-1">Total Candles</p>
                <p className="text-xl font-bold text-purple-900">{strategyStatus?.totalCandles?.toLocaleString() || '0'}</p>
              </div>
            </div>

            {strategyStatus?.lastFetch && (
              <div className="p-4 bg-gradient-to-br from-green-50 to-green-100 rounded-xl border border-green-200">
                <p className="text-sm text-green-600 font-medium mb-1">Last Update</p>
                <p className="text-lg font-semibold text-green-900">{new Date(strategyStatus.lastFetch).toLocaleString()}</p>
              </div>
            )}

            {strategyStatus?.firstCandle && strategyStatus?.lastCandle && (
              <div className="p-4 bg-gradient-to-br from-orange-50 to-orange-100 rounded-xl border border-orange-200">
                <p className="text-sm text-orange-600 font-medium mb-2">Data Range</p>
                <div className="space-y-1">
                  <p className="text-sm text-orange-900">
                    <span className="font-semibold">From:</span> {new Date(strategyStatus.firstCandle).toLocaleString()}
                  </p>
                  <p className="text-sm text-orange-900">
                    <span className="font-semibold">To:</span> {new Date(strategyStatus.lastCandle).toLocaleString()}
                  </p>
                </div>
              </div>
            )}

            <div className="flex gap-4 pt-4">
              <button
                onClick={handleStartStrategy}
                disabled={loading || strategyStatus?.running}
                className="flex-1 bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 disabled:from-gray-400 disabled:to-gray-400 text-white font-semibold py-4 rounded-xl transition-all duration-200 shadow-lg hover:shadow-xl disabled:shadow-none transform hover:-translate-y-0.5"
              >
                {loading ? '⏳ Starting...' : '▶️ Start Strategy'}
              </button>
              <button
                onClick={handleStopStrategy}
                disabled={loading || !strategyStatus?.running}
                className="flex-1 bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 disabled:from-gray-400 disabled:to-gray-400 text-white font-semibold py-4 rounded-xl transition-all duration-200 shadow-lg hover:shadow-xl disabled:shadow-none transform hover:-translate-y-0.5"
              >
                {loading ? '⏳ Stopping...' : '⏹️ Stop Strategy'}
              </button>
            </div>
          </div>
        </div>

        {/* Stats Card */}
        <div className="bg-white rounded-2xl shadow-lg p-6 border border-gray-100">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">Quick Stats</h2>
          <div className="space-y-4">
            <div className="p-4 bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl border border-blue-200">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm text-blue-600 font-medium">Candles Today</p>
                <span className="text-2xl">📊</span>
              </div>
              <p className="text-3xl font-bold text-blue-900">{strategyStatus?.totalCandles?.toLocaleString() || '0'}</p>
            </div>
            
            <div className="p-4 bg-gradient-to-br from-purple-50 to-purple-100 rounded-xl border border-purple-200">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm text-purple-600 font-medium">Active Positions</p>
                <span className="text-2xl">💼</span>
              </div>
              <p className="text-3xl font-bold text-purple-900">0</p>
            </div>
            
            <div className="p-4 bg-gradient-to-br from-green-50 to-green-100 rounded-xl border border-green-200">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm text-green-600 font-medium">P&L Today</p>
                <span className="text-2xl">💰</span>
              </div>
              <p className="text-3xl font-bold text-green-900">₹0</p>
            </div>

            <div className="p-4 bg-gradient-to-br from-orange-50 to-orange-100 rounded-xl border border-orange-200">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm text-orange-600 font-medium">Win Rate</p>
                <span className="text-2xl">🎯</span>
              </div>
              <p className="text-3xl font-bold text-orange-900">--</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};