import { useEffect, useState } from 'react';
import { tradingService } from '../services/api';

interface CandleRecord {
  timestamp: string;
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export const DataViewer = () => {
  const [records, setRecords] = useState<CandleRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [symbolFilter, setSymbolFilter] = useState('NSE:NIFTY50-INDEX');
  const [recordsPerPage, setRecordsPerPage] = useState(100);
  const [currentPage, setCurrentPage] = useState(0);
  const [totalRecords, setTotalRecords] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [exportDuration, setExportDuration] = useState(30);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const result = await tradingService.getCandles({
        symbol: symbolFilter,
        limit: recordsPerPage,
        offset: currentPage,
      });
      setRecords(result.candles);
      setTotalRecords(result.count);
    } catch (err) {
      console.error('Data fetch error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [symbolFilter, recordsPerPage, currentPage]);

  const handleExportData = async () => {
    setIsExporting(true);
    try {
      const result = await tradingService.exportCandles({
        symbol: symbolFilter,
        days: exportDuration,
      });
      alert(`✅ Successfully exported!\n📁 Location: ${result.file}\n📊 Total records: ${result.rows}`);
    } catch (err) {
      console.error('Export error:', err);
      alert('❌ Export operation failed');
    } finally {
      setIsExporting(false);
    }
  };

  const navigatePrevious = () => {
    if (currentPage > 0) {
      setCurrentPage(Math.max(0, currentPage - recordsPerPage));
    }
  };

  const navigateNext = () => {
    setCurrentPage(currentPage + recordsPerPage);
  };

  const formatPrice = (value: string) => parseFloat(value).toFixed(2);
  const formatVolume = (value: string) => parseInt(value).toLocaleString();

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="bg-gradient-to-r from-indigo-600 to-purple-600 rounded-2xl shadow-xl p-8 mb-8 text-white">
        <h1 className="text-3xl font-bold mb-2">📊 Database Viewer</h1>
        <p className="text-indigo-100">Browse and export your stored market data</p>
      </div>

      {/* Filters Card */}
      <div className="bg-white rounded-2xl shadow-lg p-6 mb-6 border border-gray-100">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">🔍 Symbol</label>
            <input
              type="text"
              value={symbolFilter}
              onChange={(e) => setSymbolFilter(e.target.value)}
              className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
              placeholder="Enter symbol"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">📄 Page Size</label>
            <select
              value={recordsPerPage}
              onChange={(e) => {
                setRecordsPerPage(Number(e.target.value));
                setCurrentPage(0);
              }}
              className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
            >
              <option value={50}>50 records</option>
              <option value={100}>100 records</option>
              <option value={200}>200 records</option>
              <option value={500}>500 records</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">📥 Export Range (days)</label>
            <div className="flex gap-2">
              <input
                type="number"
                value={exportDuration}
                onChange={(e) => setExportDuration(Number(e.target.value))}
                className="flex-1 px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                min="1"
                max="365"
              />
              <button
                onClick={handleExportData}
                disabled={isExporting}
                className="px-6 py-3 bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 disabled:from-gray-400 disabled:to-gray-400 text-white font-semibold rounded-xl transition-all shadow-lg hover:shadow-xl"
              >
                {isExporting ? '⏳' : '💾'}
              </button>
            </div>
          </div>
        </div>

        <button
          onClick={loadData}
          disabled={isLoading}
          className="mt-4 px-8 py-3 bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 disabled:from-gray-400 disabled:to-gray-400 text-white font-semibold rounded-xl transition-all shadow-lg hover:shadow-xl"
        >
          {isLoading ? '⏳ Loading...' : '🔄 Refresh Data'}
        </button>
      </div>

      {/* Data Table */}
      <div className="bg-white rounded-2xl shadow-lg overflow-hidden border border-gray-100">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gradient-to-r from-gray-50 to-gray-100">
              <tr>
                <th className="px-6 py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">⏱️ Timestamp</th>
                <th className="px-6 py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">📅 Date Time</th>
                <th className="px-6 py-4 text-right text-xs font-bold text-gray-700 uppercase tracking-wider">📈 Open</th>
                <th className="px-6 py-4 text-right text-xs font-bold text-gray-700 uppercase tracking-wider">⬆️ High</th>
                <th className="px-6 py-4 text-right text-xs font-bold text-gray-700 uppercase tracking-wider">⬇️ Low</th>
                <th className="px-6 py-4 text-right text-xs font-bold text-gray-700 uppercase tracking-wider">📊 Close</th>
                <th className="px-6 py-4 text-right text-xs font-bold text-gray-700 uppercase tracking-wider">📦 Volume</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-100">
              {records.map((record, idx) => (
                <tr key={idx} className="hover:bg-blue-50 transition-colors">
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{record.timestamp}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{new Date(record.datetime).toLocaleString()}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold text-gray-900">{formatPrice(record.open)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold text-green-600">{formatPrice(record.high)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold text-red-600">{formatPrice(record.low)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold text-gray-900">{formatPrice(record.close)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-600">{formatVolume(record.volume)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="bg-gradient-to-r from-gray-50 to-gray-100 px-6 py-4 flex items-center justify-between border-t border-gray-200">
          <div className="text-sm font-medium text-gray-700">
            Showing page {Math.floor(currentPage / recordsPerPage) + 1} • {totalRecords} records
          </div>
          <div className="flex gap-2">
            <button
              onClick={navigatePrevious}
              disabled={currentPage === 0}
              className="px-6 py-2 bg-white border-2 border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed font-semibold text-gray-700 transition-all shadow-sm hover:shadow"
            >
              ← Previous
            </button>
            <button
              onClick={navigateNext}
              disabled={totalRecords < recordsPerPage}
              className="px-6 py-2 bg-white border-2 border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed font-semibold text-gray-700 transition-all shadow-sm hover:shadow"
            >
              Next →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};