# Kho Mộc

Ứng dụng web cá nhân để quản lý danh mục sản phẩm, đơn hàng, khách hàng và lịch sử nhập vật tư. Dữ liệu được đồng bộ qua API đăng nhập, lưu trong Neon PostgreSQL và có thể dùng trên nhiều thiết bị. Ứng dụng không quản lý số lượng tồn kho.

## Triển khai lần đầu

1. Tạo database PostgreSQL trên Neon và sao chép connection string dạng pooled vào biến môi trường `DATABASE_URL`.
2. Đẩy dự án lên GitHub và import repository vào Vercel. Vercel phục vụ website HTTPS và chạy các API trong thư mục `api/`.
3. Thêm các biến môi trường sau trong cài đặt Vercel cho Production (và Preview nếu cần):
   - `DATABASE_URL`: connection string Neon; chỉ dùng phía server.
   - `OWNER_EMAIL`: email đăng nhập duy nhất.
   - `OWNER_PASSWORD`: mật khẩu dài, riêng cho ứng dụng, tối thiểu 12 ký tự.
   - `SESSION_SECRET`: chuỗi ngẫu nhiên riêng, tối thiểu 32 ký tự. Có thể tạo bằng `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
4. Deploy. API tự tạo bảng cần thiết trong Neon khi được gọi lần đầu; database user cần quyền tạo bảng và index. Không đưa các biến trên vào mã trình duyệt hoặc repository.
5. Mở URL HTTPS Vercel, đăng nhập bằng email và mật khẩu đã cấu hình. Mở cùng URL trên điện thoại để truy cập cùng dữ liệu.

```powershell
npm install
npx vercel dev --local
```

Lệnh chạy local yêu cầu Vercel CLI và các biến môi trường trong `.env.local`. `--local` tránh yêu cầu liên kết Vercel project khi chạy trên máy. Không dùng `python -m http.server` để chạy bản online vì các API đăng nhập, database và hình ảnh cần server functions.

## Chuyển dữ liệu từ bản cũ

Trước khi chuyển địa chỉ từ localhost sang domain Vercel, mở bản cũ trên đúng máy/trình duyệt đang chứa dữ liệu và bấm **Xuất dữ liệu**. Nếu đã cập nhật mã sang bản online, trên màn hình đăng nhập có nút **Xuất dữ liệu cũ trên thiết bị này** để lấy dữ liệu localStorage/IndexedDB trước đó. Giữ file JSON an toàn. Khi đăng nhập lần đầu trên domain Vercel với database còn trống, chọn file JSON đó trong ô **Bản sao lưu từ app cũ**. Sản phẩm, khách hàng, đơn hàng, phiếu nhập, lịch sử quà và hình ảnh trong file sẽ được nhập lên Neon. Bản cũ trên thiết bị không bị xóa.

Nếu lần đăng nhập đầu diễn ra trên chính origin còn dữ liệu cũ và IndexedDB ảnh cũ, app sẽ tự nhập dữ liệu đó khi Neon còn trống. Browser storage trên localhost không được domain Vercel đọc trực tiếp, nên file sao lưu là cách chuyển an toàn giữa hai địa chỉ.

Chỉ nhập bản sao lưu khi database Neon chưa có dữ liệu. Sau khi khởi tạo, các thiết bị dùng chung database; không nhập lại file cũ để tránh ghi đè các thay đổi mới.

## Quy trình

1. Thêm sản phẩm với tên, mã hàng (nếu có), đơn vị tính và hình ảnh nhận diện. Có thể khai báo size cùng giá bán và giá mua theo từng đơn vị; nếu không chia size, nhập giá mua mặc định và giá bán ở đơn.
2. Có thể thêm khách hàng với họ tên, số điện thoại và link mạng xã hội (nếu có), hoặc để ứng dụng tạo hồ sơ ngay trong lúc lên đơn.
3. Khi tạo đơn, nhập số điện thoại khách hàng. Nếu số đã có trong danh bạ, đơn sẽ gắn với hồ sơ đó; nếu chưa có, nhập họ tên và hồ sơ mới sẽ được lưu cùng đơn. Chọn mặt hàng; với sản phẩm có bảng size, chọn size để tự điền giá bán. Có thể điều chỉnh giá riêng cho đơn. Mặt hàng không chia size thì nhập giá bán ở đơn.
4. Bấm vào chỉ số **Doanh thu** trên tổng quan để xem chi tiết theo tháng hoặc toàn bộ thời gian: doanh thu, Giá vốn, lãi gộp ước tính, hiệu quả theo sản phẩm/size và chi tiết từng đơn. Lãi gộp = doanh thu − giá vốn; chưa trừ chi phí vận hành.
5. Giá vốn của đơn mới được chụp từ giá mua theo size hoặc giá mua mặc định của sản phẩm tại thời điểm lên đơn. Đơn lịch sử chưa có giá vốn sẽ dùng giá mua hiện tại để ước tính nếu có; các dòng được ước tính được đánh dấu trong báo cáo.
6. Doanh thu và tổng chi tiêu của khách được tính từ các đơn chưa bị hủy; đơn hủy không được tính. Cập nhật trạng thái đơn để theo dõi tiến độ.
7. Mỗi khách được tích lũy cá qua các đơn chưa bị hủy: dòng sản phẩm có đơn vị tính **con**, **cá** hoặc **con cá** được tính vào số cá đã mua. Đủ mỗi 10 con sẽ tạo một lượt nhắc tặng 1 con; các mốc là cộng dồn, không reset theo tháng. Khi một đơn mới đạt mốc, form hiển thị bảng mặt hàng, số lượng, đơn giá, thành tiền và số lượng cá tặng; quà được gán cho dòng cá làm khách vừa đạt mốc. Tổng đơn hiển thị thêm tổng số lượng theo từng đơn vị. Trên tổng quan, bấm **Đã tặng** để ghi nhận quà đã trao. Đơn bị hủy hoặc xóa sẽ không còn được tính; lượt tặng chưa trao sẽ tạm ẩn nếu khách không còn đủ mốc.
8. Dùng menu **Nhập vật tư** để ghi ngày nhập, vật tư/sản phẩm, đơn vị, số lượng, đơn giá mua, nhà cung cấp và ghi chú. Phiếu nhập chỉ là nhật ký chi phí, không thay đổi tồn kho và không được trừ trực tiếp khỏi lãi gộp.
9. Xuất JSON định kỳ để sao lưu dữ liệu và hình ảnh sản phẩm. Giữ bản sao lưu ở nơi riêng tư vì có thông tin liên hệ khách hàng.

## Lưu trữ và quyền riêng tư

Thông tin sản phẩm, đơn hàng, phiếu nhập, quà tặng và khách hàng được lưu trong Neon PostgreSQL; ảnh sản phẩm lưu trong database dưới dạng dữ liệu nhị phân. Website gọi API cùng origin; connection string Neon không được gửi xuống trình duyệt. API chỉ cho tài khoản chủ cửa hàng đã cấu hình đăng nhập, dùng cookie `HttpOnly`, giới hạn thử đăng nhập và từ chối ghi dữ liệu từ origin khác. Trang đang mở kiểm tra cập nhật từ thiết bị khác định kỳ mỗi 30 giây. Mỗi lần ghi có revision để phát hiện dữ liệu vừa được thay đổi trên thiết bị khác; khi thấy thông báo xung đột, tải lại trang để lấy bản mới nhất trước khi thử lại.

Đăng xuất khỏi thiết bị dùng chung. Vercel/Neon là dịch vụ cloud bên ngoài; hãy cấu hình sao lưu tự động cho database trong Neon và vẫn xuất JSON định kỳ. Không chia sẻ file sao lưu hoặc các giá trị bí mật trong biến môi trường.
