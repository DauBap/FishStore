# Fish Store

Ứng dụng web cá nhân để quản lý danh mục sản phẩm, đơn hàng, khách hàng, chi phí vận hành, lịch sử nhập vật tư và lịch sử nhập cá. Dữ liệu được đồng bộ qua API, lưu trong Neon PostgreSQL và có thể dùng trên nhiều thiết bị. Ứng dụng không quản lý số lượng tồn kho.

## Triển khai lần đầu

1. Tạo database PostgreSQL trên Neon và sao chép connection string dạng pooled.
2. Đẩy dự án lên GitHub và import repository vào Vercel. Vercel phục vụ website HTTPS và chạy các API trong thư mục `api/`.
3. Thêm các biến môi trường trong Vercel Project Settings → Environment Variables:
   - `DATABASE_URL`: pooled connection string Neon; chỉ dùng phía server.
   - `SESSION_SECRET`: chuỗi ngẫu nhiên riêng tối thiểu 32 ký tự. Tạo bằng `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
4. Bật **Vercel Authentication** trong Project Settings → Deployment Protection trước lần đầu mở app để ngăn người khác chiếm bước tạo tài khoản chủ. Giữ bảo vệ này bật như lớp bảo vệ bổ sung.
5. Deploy, mở app sau khi đã được Vercel cho phép, rồi tạo tài khoản chủ đầu tiên ở màn hình thiết lập. Tên tài khoản và mật khẩu đã băm được lưu trong bảng `fish_store_owner`; không cần `OWNER_EMAIL` hay `OWNER_PASSWORD`. Database user cần quyền tạo bảng và index. Không đưa biến môi trường vào mã trình duyệt hoặc repository.

Nếu database đã có các bảng của Kho Mộc, lần gọi API đầu tiên sẽ đổi tên bảng sang tiền tố `fish_store_` trong một thao tác an toàn, giữ nguyên dữ liệu và quan hệ ảnh. Nếu đồng thời tồn tại cả bảng tên cũ lẫn mới, migration sẽ dừng và báo lỗi thay vì ghi đè dữ liệu.

Khi nâng cấp từ phiên bản lưu dữ liệu trong `fish_store_data`, lần gọi API đầu tiên sẽ chuyển từng bản ghi sang các bảng riêng (`fish_store_products`, `fish_store_customers`, `fish_store_orders`, `fish_store_receipts`, `fish_store_fish_intakes`, `fish_store_expenses`, `fish_store_fish_rewards` và `fish_store_units`). Migration và mỗi lần lưu snapshot được áp dụng nguyên tử; revision tiếp tục phát hiện xung đột giữa các thiết bị. Bảng `fish_store_data` cũ được giữ nguyên làm bản sao dự phòng chỉ đọc, không còn là nơi ghi dữ liệu hoạt động.

Tài khoản chủ được lưu riêng trong `fish_store_owner`; chỉ cho phép tạo một lần khi bảng chưa có tài khoản. Mật khẩu được băm bằng scrypt kèm salt ngẫu nhiên, không lưu mật khẩu gốc. Bước thiết lập đầu tiên tự đăng nhập tài khoản mới tạo.

```powershell
npm install
.\scripts\dev-local.ps1
```

Trước lần chạy đầu, điền `DATABASE_URL` và `SESSION_SECRET` (tối thiểu 32 ký tự) trong `.env.local`; file này đã bị Git bỏ qua. Chạy app rồi tạo tài khoản chủ trong màn hình thiết lập. Script nạp biến môi trường rồi chạy Vercel CLI ở chế độ local. Không dùng `python -m http.server` vì API database và hình ảnh cần server functions.

## Chuyển dữ liệu từ bản cũ

Khi mở app lần đầu trên cùng origin (cùng địa chỉ và trình duyệt) đang có dữ liệu cũ, app sẽ tự nhập localStorage và ảnh IndexedDB đó nếu Neon chưa có dữ liệu. Nếu ảnh cục bộ bị thiếu, dữ liệu sản phẩm vẫn được nhập nhưng ảnh cũ sẽ được bỏ qua; mở mục **Sản phẩm** để tải ảnh mới lên. Dữ liệu local trên `localhost` không được domain Vercel đọc trực tiếp; hãy dùng chức năng **Xuất dữ liệu** của bản cũ để giữ một bản sao lưu riêng trước khi chuyển.

## Quy trình

1. Thêm sản phẩm với tên; mã hàng, đơn vị tính, giá, size, hình ảnh và mô tả đều có thể để trống. Đơn vị tính có thể chọn từ danh sách đã lưu trên database hoặc dùng **+ Thêm mới**. Đơn vị mới được lưu lên database ngay khi xác nhận. Có thể khai báo size và để trống giá bán hoặc giá mua; các ô giá tự thêm dấu phẩy để dễ đọc.
2. Có thể thêm khách hàng với họ tên; số điện thoại và link mạng xã hội đều tùy chọn. Nếu số điện thoại được nhập, cần ít nhất 8 chữ số.
3. Khi tạo đơn, thông tin khách hàng không bắt buộc; có thể lưu đơn không gắn hồ sơ hoặc nhập họ tên để tạo hồ sơ. Chọn ít nhất một sản phẩm. Số lượng mặc định là 1, giá bán có thể để trống (khi đó được tính là 0). Với sản phẩm có bảng size, size và giá đều có thể để trống; giá theo size tự điền khi chọn size nếu đã khai báo.
4. Bấm vào chỉ số **Doanh thu** trên tổng quan để xem chi tiết theo tháng hoặc toàn bộ thời gian: doanh thu, Giá vốn, lãi gộp ước tính, hiệu quả theo sản phẩm/size và chi tiết từng đơn. Lãi gộp = doanh thu − giá vốn; chưa trừ chi phí vận hành. Xem tổng chi phí vận hành riêng trong mục **Chi phí vận hành**.
5. Giá vốn của đơn mới được chụp từ giá mua theo size hoặc giá mua mặc định của sản phẩm tại thời điểm lên đơn. Đơn lịch sử chưa có giá vốn sẽ dùng giá mua hiện tại để ước tính nếu có; các dòng được ước tính được đánh dấu trong báo cáo.
6. Đơn hàng được ghi nhận là giao trực tiếp khi tạo; trạng thái và bộ lọc trạng thái hiện không hiển thị. Đơn lịch sử đã bị hủy vẫn được loại khỏi doanh thu và tổng chi tiêu của khách.
7. Mỗi khách được tích lũy cá qua các đơn chưa bị hủy: dòng sản phẩm có đơn vị tính **con**, **cá** hoặc **con cá** được tính vào số cá đã mua. Đủ mỗi 10 con sẽ tạo một lượt nhắc tặng 1 con; các mốc là cộng dồn, không reset theo tháng. Khi một đơn mới đạt mốc, form hiển thị bảng mặt hàng, số lượng, đơn giá, thành tiền và số lượng cá tặng; quà được gán cho dòng cá làm khách vừa đạt mốc. Tổng đơn hiển thị thêm tổng số lượng theo từng đơn vị. Trên tổng quan, bấm **Đã tặng** để ghi nhận quà đã trao, hoặc **Không tặng** để bỏ qua vĩnh viễn mốc đó; lượt bỏ qua không tính vào số quà đã tặng. Nút **Lịch sử** hiển thị các mốc đã tặng và đã chọn không tặng; có thể xóa lần ghi nhận **Đã tặng** nếu bấm nhầm, khi khách còn đủ mốc thì quà sẽ trở lại danh sách cần tặng. Đơn bị hủy hoặc xóa sẽ không còn được tính; lượt tặng chưa trao sẽ tạm ẩn nếu khách không còn đủ mốc.
8. Dùng menu **Nhập vật tư** để ghi ngày nhập, vật tư/sản phẩm, đơn vị, số lượng, đơn giá mua, nhà cung cấp và ghi chú. Phiếu nhập chỉ là nhật ký chi phí, không thay đổi tồn kho và không được trừ trực tiếp khỏi lãi gộp.
9. Dùng menu **Nhập cá** để chọn sản phẩm trong danh mục, hoặc tạo sản phẩm mới ngay trong cửa sổ nhập cá. Ghi số lượng, giá mua, chi phí khác (ví dụ phí ship), ngày, nhà cung cấp và ghi chú; sản phẩm đã chọn sẽ tự điền đơn vị và giá mua mặc định nếu có. Tổng chi phí gồm tiền cá và chi phí khác. Phiếu nhập chỉ lưu lịch sử và chi phí, không cộng tồn kho.
10. Dùng menu **Chi phí vận hành** để ghi riêng các khoản như cám, thức ăn, thuốc và vật dụng chăm sóc cá. Trang hiển thị tổng chi phí tháng này và tổng đã ghi; khoản chi được theo dõi riêng, chưa trừ khỏi lãi gộp.
11. Xuất JSON định kỳ để sao lưu dữ liệu và hình ảnh sản phẩm. Giữ bản sao lưu ở nơi riêng tư vì có thông tin liên hệ khách hàng.

## Lưu trữ và quyền riêng tư

Thông tin sản phẩm, đơn hàng, phiếu nhập vật tư, phiếu nhập cá, chi phí vận hành, quà tặng, tài khoản chủ và khách hàng được lưu trong Neon PostgreSQL; mỗi nhóm dữ liệu cửa hàng có bảng riêng, còn snapshot `fish_store_data` cũ được giữ chỉ để dự phòng sau khi migration. Mật khẩu tài khoản được băm bằng scrypt, ảnh sản phẩm lưu trong database dưới dạng dữ liệu nhị phân. Website gọi API cùng origin; connection string Neon không được gửi xuống trình duyệt. API yêu cầu tài khoản cửa hàng, dùng cookie `HttpOnly`, giới hạn thử đăng nhập và từ chối ghi dữ liệu từ origin khác. Vercel Deployment Protection phải bật trước khi tạo tài khoản chủ lần đầu và nên tiếp tục được bật như lớp bảo vệ bổ sung. Trang đang mở kiểm tra cập nhật từ thiết bị khác định kỳ mỗi 30 giây. Mỗi lần ghi có revision để phát hiện dữ liệu vừa được thay đổi trên thiết bị khác; khi thấy thông báo xung đột, tải lại trang để lấy bản mới nhất trước khi thử lại.

Trên thiết bị dùng chung, đăng xuất phiên Vercel sau khi sử dụng và đóng trình duyệt. Vercel/Neon là dịch vụ cloud bên ngoài; hãy cấu hình sao lưu tự động cho database trong Neon và vẫn xuất JSON định kỳ. Không chia sẻ file sao lưu hoặc connection string.
