import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { Lock } from "lucide-react";

const Login = () => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const { login } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    const success = await login(password, username);

    if (success) {
      setError("");
    } else {
      setError("Invalid username or password");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div
        className="max-w-md w-full space-y-8 backdrop-blur-sm p-8 shadow-lg"
        style={{ backgroundColor: "#211f27" }}
      >
        <div className="text-center">
          <div
            className="mx-auto h-12 w-12 flex items-center justify-center mb-4"
            style={{ backgroundColor: "#211f27" }}
          >
            <Lock className="h-6 w-6" style={{ color: "#707e61" }} />
          </div>
          <h2
            className="mt-2 text-3xl font-extrabold"
            style={{ color: "#fff" }}
          >
            Login Required
          </h2>
          <p className="mt-2 text-sm" style={{ color: "#c1c1c3" }}>
            Please enter your credentials to access Aurral
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <label htmlFor="username" className="sr-only">
                Username
              </label>
              <input
                id="username"
                name="username"
                type="text"
                required
                autoComplete="username"
                className="appearance-none relative block w-full px-3 py-2 placeholder-gray-500 focus:outline-none focus:ring-2 focus:z-10 sm:text-sm"
                style={{
                  focusRingColor: "#c1c1c3",
                  backgroundColor: "#211f27",
                  color: "#fff",
                }}
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="password" className="sr-only">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className="appearance-none relative block w-full px-3 py-2 placeholder-gray-500 focus:outline-none focus:ring-2 focus:z-10 sm:text-sm"
                style={{
                  focusRingColor: "#c1c1c3",
                  backgroundColor: "#211f27",
                  color: "#fff",
                }}
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <div className="text-sm text-center" style={{ color: "#ff6b6b" }}>
              {error}
            </div>
          )}

          <div>
            <button
              type="submit"
              className="group relative w-full flex justify-center py-2 px-4 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-offset-2 transition-colors duration-200"
              style={{ backgroundColor: "#707e61", color: "#fff" }}
            >
              Sign in
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Login;
