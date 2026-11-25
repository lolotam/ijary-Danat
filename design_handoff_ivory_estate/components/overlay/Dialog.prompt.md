CRUD modal used across every admin module (add tenant, record payment…).

```jsx
<Dialog open={open} onOpenChange={setOpen}>
  <DialogHeader>
    <DialogTitle>إضافة مستأجر</DialogTitle>
    <DialogDescription>أدخل بيانات المستأجر.</DialogDescription>
  </DialogHeader>
  …fields…
  <DialogFooter>
    <Button variant="outline">إلغاء</Button>
    <Button>حفظ التغييرات</Button>
  </DialogFooter>
</Dialog>
```
