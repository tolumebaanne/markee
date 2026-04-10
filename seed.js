require('dotenv').config({ path: './auth-service/.env' });
const mongoose = require('mongoose');

async function seed() {
    await mongoose.connect(process.env.CATALOG_URI || process.env.MONGODB_URI);
    
    const ProductSchema = new mongoose.Schema({
        sellerId: mongoose.Schema.Types.ObjectId,
        title: String, description: String, category: String, price: Number, images: [String], status: String
    });
    const Product = mongoose.model('Product', ProductSchema);
    
    // Clear old
    await Product.deleteMany({});
    
    // Create new
    await Product.insertMany([
        {
            sellerId: new mongoose.Types.ObjectId(),
            title: "Noise Cancelling Headphones",
            description: "Premium over-ear headphones with active noise cancellation and 30-hour battery life.",
            category: "Electronics",
            price: 29900,
            images: ["https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=500&q=80"],
            status: "active"
        },
        {
            sellerId: new mongoose.Types.ObjectId(),
            title: "Minimalist Leather Minimalist Watch",
            description: "A sleek, low-profile watch with a genuine leather strap.",
            category: "Accessories",
            price: 14500,
            images: ["https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=500&q=80"],
            status: "active"
        },
        {
            sellerId: new mongoose.Types.ObjectId(),
            title: "Mechanical Keyboard Pro",
            description: "RGB mechanical keyboard with tactile brown switches.",
            category: "Electronics",
            price: 12000,
            images: ["https://images.unsplash.com/photo-1595225476474-87563907a212?w=500&q=80"],
            status: "active"
        },
        {
            sellerId: new mongoose.Types.ObjectId(),
            title: "Ceramic Coffee Mug",
            description: "Hand-crafted ceramic mug perfect for your morning brew.",
            category: "Home",
            price: 2400,
            images: ["https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=500&q=80"],
            status: "active"
        }
    ]);
    
    console.log("Seeded!");
    process.exit(0);
}
seed();
