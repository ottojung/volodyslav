import React from 'react';
import { Link } from 'react-router-dom';

function App() {
  return (
    <div>
      <h1>Hello, world!</h1>
      <p><Link to="/camera">Open Camera</Link></p>
    </div>
  );
}

export default App;
