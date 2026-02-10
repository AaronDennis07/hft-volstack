import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export const Navbar = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();

  const isActive = (path: string) => location.pathname === path;

  const navLinks = [
    { path: '/dashboard', label: 'Dashboard', icon: '📊' },
    { path: '/data', label: 'Data Viewer', icon: '📈' },
  ];

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <nav className="bg-gradient-to-r from-blue-600 to-indigo-700 shadow-lg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo and Brand */}
          <div className="flex items-center">
            <div 
              className="flex items-center cursor-pointer"
              onClick={() => navigate('/dashboard')}
            >
              <div className="bg-white p-2 rounded-lg shadow-md">
                <span className="text-2xl">📉</span>
              </div>
              <div className="ml-3">
                <h1 className="text-2xl font-bold text-white">Volstack</h1>
                <p className="text-xs text-blue-100">Trading Platform</p>
              </div>
            </div>
          </div>

          {/* Navigation Links */}
          <div className="hidden md:flex items-center space-x-1">
            {navLinks.map((link) => (
              <button
                key={link.path}
                onClick={() => navigate(link.path)}
                className={`
                  flex items-center px-4 py-2 rounded-lg transition-all duration-200
                  ${isActive(link.path)
                    ? 'bg-white text-blue-600 shadow-md'
                    : 'text-white hover:bg-blue-500 hover:bg-opacity-30'
                  }
                `}
              >
                <span className="mr-2">{link.icon}</span>
                <span className="font-medium">{link.label}</span>
              </button>
            ))}
          </div>

          {/* User Menu */}
          <div className="flex items-center space-x-4">
            <div className="hidden sm:block text-right">
              <p className="text-sm font-medium text-white">
                {user?.name || 'Trader'}
              </p>
              <p className="text-xs text-blue-100">
                {user?.email || 'trader@volstack.com'}
              </p>
            </div>
            <div className="flex items-center space-x-2">
              <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center shadow-md">
                <span className="text-blue-600 font-bold">
                  {(user?.name || 'T').charAt(0).toUpperCase()}
                </span>
              </div>
              <button
                onClick={handleLogout}
                className="ml-2 px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors duration-200 shadow-md"
              >
                Logout
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Navigation */}
        <div className="md:hidden pb-3 space-y-1">
          {navLinks.map((link) => (
            <button
              key={link.path}
              onClick={() => navigate(link.path)}
              className={`
                w-full flex items-center px-3 py-2 rounded-lg transition-all duration-200
                ${isActive(link.path)
                  ? 'bg-white text-blue-600'
                  : 'text-white hover:bg-blue-500 hover:bg-opacity-30'
                }
              `}
            >
              <span className="mr-2">{link.icon}</span>
              <span className="font-medium">{link.label}</span>
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
};