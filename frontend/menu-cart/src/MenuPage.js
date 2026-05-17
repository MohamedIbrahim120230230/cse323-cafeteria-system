import React, { useState, useEffect } from 'react';
import axios from 'axios';

const API = 'http://127.0.0.1:5001';
const USER_ID = '94ad2601-fc07-44f3-9e33-561fb34dd80d';

export default function MenuPage() {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [cart, setCart] = useState([]);
  const [voucher, setVoucher] = useState('');
  const [discount, setDiscount] = useState(0);
  const [voucherMsg, setVoucherMsg] = useState('');
  const [voucherApplied, setVoucherApplied] = useState(false);

  // FR09, FR10 — fetch menu
  useEffect(() => {
    fetchMenu();
  }, [category]);

  const fetchMenu = async () => {
    try {
      if (search) {
        const res = await axios.get(`${API}/api/menu/search?q=${search}`);
        setItems(res.data);
      } else {
        const res = await axios.get(`${API}/api/menu${category ? `?category=${category}` : ''}`);
        setItems(res.data);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // FR11 — add to cart
  const addToCart = async (item) => {
    if (item.stock_qty === 0) return;
    const existing = cart.find(c => c.id === item.id);
    if (existing) {
      if (existing.qty >= item.max_order_qty) {
        alert(`Maximum order quantity is ${item.max_order_qty}`);
        return;
      }
      setCart(cart.map(c => c.id === item.id ? { ...c, qty: c.qty + 1 } : c));
    } else {
      setCart([...cart, { ...item, qty: 1 }]);
    }

    // Sync with backend
    try {
      await axios.post(`${API}/api/cart/${USER_ID}/add`, {
        item_id: item.id,
        qty: 1
      });
    } catch (err) {
      console.error('Cart sync error:', err);
    }
  };

  // FR12 — remove from cart
  const removeFromCart = (id) => {
    setCart(cart.filter(c => c.id !== id));
  };

  // FR12 — update quantity
  const updateQty = (id, qty) => {
    if (qty < 1) { removeFromCart(id); return; }
    const item = items.find(i => i.id === id);
    if (item && qty > item.max_order_qty) {
      alert(`Maximum order quantity is ${item.max_order_qty}`);
      return;
    }
    setCart(cart.map(c => c.id === id ? { ...c, qty } : c));
  };

  // Cart total
  const total = cart.reduce((sum, c) => sum + c.price * c.qty, 0);
  const finalTotal = Math.max(0, total - discount); // FR16

  // FR13 — apply voucher
  const applyVoucher = async () => {
    // FR15 — prevent stacking
    if (voucherApplied) {
      setVoucherMsg('A voucher has already been applied. Stacking is not allowed');
      return;
    }
    try {
      const res = await axios.post(`${API}/api/cart/${USER_ID}/voucher`, { code: voucher });
      setDiscount(res.data.discount);
      setVoucherMsg(`Voucher applied! You save ${res.data.discount} EGP`);
      setVoucherApplied(true);
    } catch (err) {
      setVoucherMsg(err.response?.data?.error || 'Invalid voucher');
      setDiscount(0);
    }
  };

  // FR17 — lock cart at checkout
  const handleCheckout = async () => {
    try {
      await axios.post(`${API}/api/cart/${USER_ID}/lock`);
      alert('Order placed! Your cart has been locked.');
    } catch (err) {
      console.error('Checkout error:', err);
    }
  };

  return (
    <div className="container-fluid">
      <div className="row">

        {/* Menu Section */}
        <div className="col-md-8 p-4">
          <h2 className="mb-4">🍽️ Cafeteria Menu</h2>

          {/* Search — FR10 */}
          <div className="input-group mb-3">
            <input
              type="text"
              className="form-control"
              placeholder="Search menu..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyUp={fetchMenu}
            />
            <button className="btn btn-primary" onClick={fetchMenu}>Search</button>
          </div>

          {/* Category Filter — FR09 */}
          <div className="mb-4">
            {['', 'meals', 'beverages', 'snacks'].map(cat => (
              <button
                key={cat}
                className={`btn me-2 ${category === cat ? 'btn-dark' : 'btn-outline-dark'}`}
                onClick={() => setCategory(cat)}
              >
                {cat === '' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1)}
              </button>
            ))}
          </div>

          {/* Menu Items */}
          <div className="row">
            {items.length === 0 && (
              <p className="text-muted">No items found.</p>
            )}
            {items.map(item => (
              <div className="col-md-4 mb-4" key={item.id}>
                <div className={`card h-100 ${item.stock_qty === 0 ? 'opacity-50' : ''}`}>
                  <div className="card-body">
                    <h5 className="card-title">{item.name}</h5>
                    <p className="text-muted">{item.category}</p>
                    <p className="fw-bold">{item.price} EGP</p>
                    {item.stock_qty === 0
                      ? <span className="badge bg-danger">Out of Stock</span>
                      : <span className="badge bg-success">In Stock ({item.stock_qty})</span>
                    }
                  </div>
                  <div className="card-footer">
                    <button
                      className="btn btn-primary w-100"
                      disabled={item.stock_qty === 0}
                      onClick={() => addToCart(item)}
                    >
                      {item.stock_qty === 0 ? 'Out of Stock' : 'Add to Cart'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Cart Sidebar — FR12 */}
        <div className="col-md-4 bg-light p-4 min-vh-100">
          <h4>🛒 Your Cart</h4>
          {cart.length === 0 && <p className="text-muted">Your cart is empty.</p>}
          {cart.map(c => (
            <div key={c.id} className="card mb-2">
              <div className="card-body p-2">
                <div className="d-flex justify-content-between align-items-center">
                  <span>{c.name}</span>
                  <button className="btn btn-sm btn-outline-danger" onClick={() => removeFromCart(c.id)}>✕</button>
                </div>
                <div className="d-flex align-items-center mt-1">
                  <button className="btn btn-sm btn-outline-secondary" onClick={() => updateQty(c.id, c.qty - 1)}>−</button>
                  <span className="mx-2">{c.qty}</span>
                  <button className="btn btn-sm btn-outline-secondary" onClick={() => updateQty(c.id, c.qty + 1)}>+</button>
                  <span className="ms-auto fw-bold">{(c.price * c.qty).toFixed(2)} EGP</span>
                </div>
              </div>
            </div>
          ))}

          {/* Voucher — FR13 */}
          {cart.length > 0 && (
            <div className="mt-3">
              <div className="input-group mb-2">
                <input
                  type="text"
                  className="form-control"
                  placeholder="Voucher code"
                  value={voucher}
                  onChange={e => setVoucher(e.target.value)}
                  disabled={voucherApplied}
                />
                <button
                  className="btn btn-outline-primary"
                  onClick={applyVoucher}
                  disabled={voucherApplied}
                >
                  Apply
                </button>
              </div>
              {voucherMsg && (
                <p className={`small ${discount > 0 ? 'text-success' : 'text-danger'}`}>{voucherMsg}</p>
              )}
            </div>
          )}

          {/* Totals */}
          {cart.length > 0 && (
            <div className="mt-3 border-top pt-3">
              <p>Subtotal: <strong>{total.toFixed(2)} EGP</strong></p>
              {discount > 0 && <p className="text-success">Discount: -{discount} EGP</p>}
              <h5>Total: {finalTotal.toFixed(2)} EGP</h5>
              <button
                className="btn btn-success w-100 mt-2"
                onClick={handleCheckout}
              >
                Proceed to Checkout
              </button>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}