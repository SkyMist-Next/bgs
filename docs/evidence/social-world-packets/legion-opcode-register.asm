
/home/kaloyan/work/re/WoW/artifacts/clients/7.3.5.26972/analysis-x64/Wow-64.analysis.exe:     file format pei-x86-64


Disassembly of section .text:

0000000140d43800 <.text+0xd42800>:
   140d43800:	4c 8b c0             	mov    r8,rax
   140d43803:	89 6c 24 20          	mov    DWORD PTR [rsp+0x20],ebp
   140d43807:	e8 24 00 6a ff       	call   0x1403e3830
   140d4380c:	4c 8b f0             	mov    r14,rax
   140d4380f:	48 85 db             	test   rbx,rbx
   140d43812:	74 0f                	je     0x140d43823
   140d43814:	49 c1 ef 03          	shr    r15,0x3
   140d43818:	48 8b f8             	mov    rdi,rax
   140d4381b:	33 c0                	xor    eax,eax
   140d4381d:	49 8b cf             	mov    rcx,r15
   140d43820:	f3 48 ab             	rep stos QWORD PTR [rdi],rax
   140d43823:	4c 8b 7c 24 30       	mov    r15,QWORD PTR [rsp+0x30]
   140d43828:	48 39 6e 08          	cmp    QWORD PTR [rsi+0x8],rbp
   140d4382c:	0f 84 7a 00 00 00    	je     0x140d438ac
   140d43832:	48 39 2e             	cmp    QWORD PTR [rsi],rbp
   140d43835:	76 75                	jbe    0x140d438ac
   140d43837:	49 ba cd 8c 55 ed d7 	movabs r10,0xff51afd7ed558ccd
   140d4383e:	af 51 ff 
   140d43841:	49 bb 53 ec 85 1a fe 	movabs r11,0xc4ceb9fe1a85ec53
   140d43848:	b9 ce c4 
   140d4384b:	0f 1f 44 00 00       	nop    DWORD PTR [rax+rax*1+0x0]
   140d43850:	48 8b 46 08          	mov    rax,QWORD PTR [rsi+0x8]
   140d43854:	4c 8b 04 e8          	mov    r8,QWORD PTR [rax+rbp*8]
   140d43858:	4d 85 c0             	test   r8,r8
   140d4385b:	74 47                	je     0x140d438a4
   140d4385d:	4c 8d 4b ff          	lea    r9,[rbx-0x1]
   140d43861:	49 63 40 08          	movsxd rax,DWORD PTR [r8+0x8]
   140d43865:	49 8b 10             	mov    rdx,QWORD PTR [r8]
   140d43868:	48 8b c8             	mov    rcx,rax
   140d4386b:	48 c1 e9 21          	shr    rcx,0x21
   140d4386f:	48 33 c8             	xor    rcx,rax
   140d43872:	49 0f af ca          	imul   rcx,r10
   140d43876:	48 8b c1             	mov    rax,rcx
   140d43879:	48 c1 e8 21          	shr    rax,0x21
   140d4387d:	48 33 c1             	xor    rax,rcx
   140d43880:	49 0f af c3          	imul   rax,r11
   140d43884:	48 8b f8             	mov    rdi,rax
   140d43887:	48 c1 ef 21          	shr    rdi,0x21
   140d4388b:	48 33 f8             	xor    rdi,rax
   140d4388e:	49 23 f9             	and    rdi,r9
   140d43891:	49 8b 04 fe          	mov    rax,QWORD PTR [r14+rdi*8]
   140d43895:	49 89 00             	mov    QWORD PTR [r8],rax
   140d43898:	4d 89 04 fe          	mov    QWORD PTR [r14+rdi*8],r8
   140d4389c:	4c 8b c2             	mov    r8,rdx
   140d4389f:	48 85 d2             	test   rdx,rdx
   140d438a2:	75 bd                	jne    0x140d43861
   140d438a4:	48 ff c5             	inc    rbp
   140d438a7:	48 3b 2e             	cmp    rbp,QWORD PTR [rsi]
   140d438aa:	72 a4                	jb     0x140d43850
   140d438ac:	48 8b 7e 08          	mov    rdi,QWORD PTR [rsi+0x8]
   140d438b0:	48 8d 0d b9 46 b6 00 	lea    rcx,[rip+0xb646b9]        # 0x1418a7f70
   140d438b7:	e8 64 52 42 00       	call   0x141168b20
   140d438bc:	45 33 c9             	xor    r9d,r9d
   140d438bf:	48 8b cf             	mov    rcx,rdi
   140d438c2:	45 8d 41 fa          	lea    r8d,[r9-0x6]
   140d438c6:	48 8b d0             	mov    rdx,rax
   140d438c9:	e8 52 00 6a ff       	call   0x1403e3920
   140d438ce:	48 8b 7c 24 58       	mov    rdi,QWORD PTR [rsp+0x58]
   140d438d3:	48 8b 6c 24 50       	mov    rbp,QWORD PTR [rsp+0x50]
   140d438d8:	4c 89 76 08          	mov    QWORD PTR [rsi+0x8],r14
   140d438dc:	4c 8b 74 24 60       	mov    r14,QWORD PTR [rsp+0x60]
   140d438e1:	48 89 1e             	mov    QWORD PTR [rsi],rbx
   140d438e4:	48 83 c4 38          	add    rsp,0x38
   140d438e8:	5e                   	pop    rsi
   140d438e9:	5b                   	pop    rbx
   140d438ea:	c3                   	ret
   140d438eb:	b0 01                	mov    al,0x1
   140d438ed:	22 68 8c             	and    ch,BYTE PTR [rax-0x74]
   140d438f0:	40 53                	rex push rbx
   140d438f2:	48 83 ec 20          	sub    rsp,0x20
   140d438f6:	33 c0                	xor    eax,eax
   140d438f8:	48 8b d9             	mov    rbx,rcx
   140d438fb:	48 89 01             	mov    QWORD PTR [rcx],rax
   140d438fe:	48 89 41 08          	mov    QWORD PTR [rcx+0x8],rax
   140d43902:	48 89 41 10          	mov    QWORD PTR [rcx+0x10],rax
   140d43906:	48 89 41 18          	mov    QWORD PTR [rcx+0x18],rax
   140d4390a:	48 89 41 20          	mov    QWORD PTR [rcx+0x20],rax
   140d4390e:	48 89 41 28          	mov    QWORD PTR [rcx+0x28],rax
   140d43912:	48 89 41 30          	mov    QWORD PTR [rcx+0x30],rax
   140d43916:	48 89 41 38          	mov    QWORD PTR [rcx+0x38],rax
   140d4391a:	48 89 41 40          	mov    QWORD PTR [rcx+0x40],rax
   140d4391e:	e8 7d 0a 00 00       	call   0x140d443a0
   140d43923:	48 8d 05 a6 05 00 00 	lea    rax,[rip+0x5a6]        # 0x140d43ed0
   140d4392a:	48 89 05 a7 bc c1 00 	mov    QWORD PTR [rip+0xc1bca7],rax        # 0x14195f5d8
   140d43931:	48 8d 05 e8 01 00 00 	lea    rax,[rip+0x1e8]        # 0x140d43b20
   140d43938:	48 89 05 09 a7 c1 00 	mov    QWORD PTR [rip+0xc1a709],rax        # 0x14195e048
   140d4393f:	48 8d 05 5a 09 00 00 	lea    rax,[rip+0x95a]        # 0x140d442a0
   140d43946:	48 89 05 33 a9 c1 00 	mov    QWORD PTR [rip+0xc1a933],rax        # 0x14195e280
   140d4394d:	48 8d 05 5c 09 00 00 	lea    rax,[rip+0x95c]        # 0x140d442b0
   140d43954:	48 89 05 ad b0 c1 00 	mov    QWORD PTR [rip+0xc1b0ad],rax        # 0x14195ea08
   140d4395b:	48 8b c3             	mov    rax,rbx
   140d4395e:	48 83 c4 20          	add    rsp,0x20
   140d43962:	5b                   	pop    rbx
   140d43963:	c3                   	ret
   140d43964:	5e                   	pop    rsi
   140d43965:	17                   	(bad)
   140d43966:	5c                   	pop    rsp
   140d43967:	2c 44                	sub    al,0x44
   140d43969:	ce                   	(bad)
   140d4396a:	50                   	push   rax
   140d4396b:	2e 48 79 f9          	cs rex.W jns 0x140d43968
   140d4396f:	f5                   	cmc
   140d43970:	48 89 5c 24 08       	mov    QWORD PTR [rsp+0x8],rbx
   140d43975:	57                   	push   rdi
   140d43976:	48 83 ec 20          	sub    rsp,0x20
   140d4397a:	48 8b 79 40          	mov    rdi,QWORD PTR [rcx+0x40]
   140d4397e:	48 8b d9             	mov    rbx,rcx
   140d43981:	48 85 ff             	test   rdi,rdi
   140d43984:	74 1e                	je     0x140d439a4
   140d43986:	48 8b cf             	mov    rcx,rdi
   140d43989:	e8 82 de ff ff       	call   0x140d41810
   140d4398e:	48 8d 15 4f 40 56 00 	lea    rdx,[rip+0x56404f]        # 0x1412a79e4
   140d43995:	45 33 c9             	xor    r9d,r9d
   140d43998:	41 83 c8 ff          	or     r8d,0xffffffff
   140d4399c:	48 8b cf             	mov    rcx,rdi
   140d4399f:	e8 7c ff 69 ff       	call   0x1403e3920
   140d439a4:	48 8b 7b 38          	mov    rdi,QWORD PTR [rbx+0x38]
   140d439a8:	48 85 ff             	test   rdi,rdi
   140d439ab:	74 1e                	je     0x140d439cb
   140d439ad:	48 8b cf             	mov    rcx,rdi
   140d439b0:	e8 cb fb ff ff       	call   0x140d43580
   140d439b5:	48 8d 15 28 40 56 00 	lea    rdx,[rip+0x564028]        # 0x1412a79e4
   140d439bc:	45 33 c9             	xor    r9d,r9d
   140d439bf:	41 83 c8 ff          	or     r8d,0xffffffff
   140d439c3:	48 8b cf             	mov    rcx,rdi
   140d439c6:	e8 55 ff 69 ff       	call   0x1403e3920
   140d439cb:	48 8b 7b 30          	mov    rdi,QWORD PTR [rbx+0x30]
   140d439cf:	48 85 ff             	test   rdi,rdi
   140d439d2:	74 27                	je     0x140d439fb
   140d439d4:	48 8d 4f 20          	lea    rcx,[rdi+0x20]
   140d439d8:	e8 43 11 00 00       	call   0x140d44b20
   140d439dd:	48 8b cf             	mov    rcx,rdi
   140d439e0:	e8 2b 12 00 00       	call   0x140d44c10
   140d439e5:	48 8d 15 f8 3f 56 00 	lea    rdx,[rip+0x563ff8]        # 0x1412a79e4
   140d439ec:	45 33 c9             	xor    r9d,r9d
   140d439ef:	41 83 c8 ff          	or     r8d,0xffffffff
   140d439f3:	48 8b cf             	mov    rcx,rdi
   140d439f6:	e8 25 ff 69 ff       	call   0x1403e3920
   140d439fb:	48 8b 7b 28          	mov    rdi,QWORD PTR [rbx+0x28]
   140d439ff:	48 85 ff             	test   rdi,rdi
   140d43a02:	74 1e                	je     0x140d43a22
   140d43a04:	48 8b cf             	mov    rcx,rdi
   140d43a07:	e8 54 b8 ff ff       	call   0x140d3f260
   140d43a0c:	48 8d 15 d1 3f 56 00 	lea    rdx,[rip+0x563fd1]        # 0x1412a79e4
   140d43a13:	45 33 c9             	xor    r9d,r9d
   140d43a16:	41 83 c8 ff          	or     r8d,0xffffffff
   140d43a1a:	48 8b cf             	mov    rcx,rdi
   140d43a1d:	e8 fe fe 69 ff       	call   0x1403e3920
   140d43a22:	48 8b 7b 20          	mov    rdi,QWORD PTR [rbx+0x20]
   140d43a26:	48 85 ff             	test   rdi,rdi
   140d43a29:	74 1e                	je     0x140d43a49
   140d43a2b:	48 8b cf             	mov    rcx,rdi
   140d43a2e:	e8 fd 93 e6 ff       	call   0x140bace30
   140d43a33:	48 8d 15 aa 3f 56 00 	lea    rdx,[rip+0x563faa]        # 0x1412a79e4
   140d43a3a:	45 33 c9             	xor    r9d,r9d
   140d43a3d:	41 83 c8 ff          	or     r8d,0xffffffff
   140d43a41:	48 8b cf             	mov    rcx,rdi
   140d43a44:	e8 d7 fe 69 ff       	call   0x1403e3920
   140d43a49:	48 8b 7b 18          	mov    rdi,QWORD PTR [rbx+0x18]
   140d43a4d:	48 85 ff             	test   rdi,rdi
   140d43a50:	74 27                	je     0x140d43a79
   140d43a52:	48 8d 4f 20          	lea    rcx,[rdi+0x20]
   140d43a56:	e8 c5 0f 00 00       	call   0x140d44a20
   140d43a5b:	48 8b cf             	mov    rcx,rdi
   140d43a5e:	e8 8d 13 00 00       	call   0x140d44df0
   140d43a63:	48 8d 15 7a 3f 56 00 	lea    rdx,[rip+0x563f7a]        # 0x1412a79e4
   140d43a6a:	45 33 c9             	xor    r9d,r9d
   140d43a6d:	41 83 c8 ff          	or     r8d,0xffffffff
   140d43a71:	48 8b cf             	mov    rcx,rdi
   140d43a74:	e8 a7 fe 69 ff       	call   0x1403e3920
   140d43a79:	48 8b 7b 10          	mov    rdi,QWORD PTR [rbx+0x10]
   140d43a7d:	48 85 ff             	test   rdi,rdi
   140d43a80:	74 1e                	je     0x140d43aa0
   140d43a82:	48 8b cf             	mov    rcx,rdi
   140d43a85:	e8 f6 9d ff ff       	call   0x140d3d880
   140d43a8a:	48 8d 15 53 3f 56 00 	lea    rdx,[rip+0x563f53]        # 0x1412a79e4
   140d43a91:	45 33 c9             	xor    r9d,r9d
   140d43a94:	41 83 c8 ff          	or     r8d,0xffffffff
   140d43a98:	48 8b cf             	mov    rcx,rdi
   140d43a9b:	e8 80 fe 69 ff       	call   0x1403e3920
   140d43aa0:	48 8b 7b 08          	mov    rdi,QWORD PTR [rbx+0x8]
   140d43aa4:	48 85 ff             	test   rdi,rdi
   140d43aa7:	74 1e                	je     0x140d43ac7
   140d43aa9:	48 8b cf             	mov    rcx,rdi
   140d43aac:	e8 2f 42 ff ff       	call   0x140d37ce0
   140d43ab1:	48 8d 15 2c 3f 56 00 	lea    rdx,[rip+0x563f2c]        # 0x1412a79e4
   140d43ab8:	45 33 c9             	xor    r9d,r9d
   140d43abb:	41 83 c8 ff          	or     r8d,0xffffffff
   140d43abf:	48 8b cf             	mov    rcx,rdi
   140d43ac2:	e8 59 fe 69 ff       	call   0x1403e3920
   140d43ac7:	48 8b 1b             	mov    rbx,QWORD PTR [rbx]
   140d43aca:	48 85 db             	test   rbx,rbx
   140d43acd:	74 27                	je     0x140d43af6
   140d43acf:	48 8d 4b 58          	lea    rcx,[rbx+0x58]
   140d43ad3:	e8 48 fd fe ff       	call   0x140d33820
   140d43ad8:	48 8b cb             	mov    rcx,rbx
   140d43adb:	e8 70 b0 fe ff       	call   0x140d2eb50
   140d43ae0:	48 8d 15 fd 3e 56 00 	lea    rdx,[rip+0x563efd]        # 0x1412a79e4
   140d43ae7:	45 33 c9             	xor    r9d,r9d
   140d43aea:	41 83 c8 ff          	or     r8d,0xffffffff
   140d43aee:	48 8b cb             	mov    rcx,rbx
   140d43af1:	e8 2a fe 69 ff       	call   0x1403e3920
   140d43af6:	48 8b 5c 24 30       	mov    rbx,QWORD PTR [rsp+0x30]
   140d43afb:	48 83 c4 20          	add    rsp,0x20
   140d43aff:	5f                   	pop    rdi
   140d43b00:	c3                   	ret
   140d43b01:	e2 4c                	loop   0x140d43b4f
   140d43b03:	30 28                	xor    BYTE PTR [rax],ch
   140d43b05:	ed                   	in     eax,dx
   140d43b06:	ff 74 31 28          	push   QWORD PTR [rcx+rsi*1+0x28]
   140d43b0a:	50                   	push   rax
   140d43b0b:	65 be b7 7e 4a 0f    	gs mov esi,0xf4a7eb7
   140d43b11:	b6 05                	mov    dh,0x5
   140d43b13:	2d 9d f3 00 c3       	sub    eax,0xc300f39d
   140d43b18:	44 a2 ce 8c 77 55 0a 	rex.R movabs ds:0x8948390a55778cce,al
   140d43b1f:	39 48 89 
   140d43b22:	5c                   	pop    rsp
   140d43b23:	24 10                	and    al,0x10
   140d43b25:	55                   	push   rbp
   140d43b26:	48 8d ac 24 70 ff ff 	lea    rbp,[rsp-0x90]
   140d43b2d:	ff 
   140d43b2e:	48 81 ec 90 01 00 00 	sub    rsp,0x190
   140d43b35:	8b 41 30             	mov    eax,DWORD PTR [rcx+0x30]
   140d43b38:	48 8b 51 20          	mov    rdx,QWORD PTR [rcx+0x20]
   140d43b3c:	48 c7 45 70 00 00 00 	mov    QWORD PTR [rbp+0x70],0x0
   140d43b43:	00 
   140d43b44:	48 c7 45 78 00 00 00 	mov    QWORD PTR [rbp+0x78],0x0
   140d43b4b:	00 
   140d43b4c:	48 8b d9             	mov    rbx,rcx
   140d43b4f:	4c 8d 49 38          	lea    r9,[rcx+0x38]
   140d43b53:	0f 10 45 70          	movups xmm0,XMMWORD PTR [rbp+0x70]
   140d43b57:	89 45 70             	mov    DWORD PTR [rbp+0x70],eax
   140d43b5a:	48 8b 41 28          	mov    rax,QWORD PTR [rcx+0x28]
   140d43b5e:	4c 8d 45 70          	lea    r8,[rbp+0x70]
   140d43b62:	0f 11 85 80 00 00 00 	movups XMMWORD PTR [rbp+0x80],xmm0
   140d43b69:	48 8d 0d 10 9d f3 00 	lea    rcx,[rip+0xf39d10]        # 0x141c7d880
   140d43b70:	48 89 45 78          	mov    QWORD PTR [rbp+0x78],rax
   140d43b74:	e8 f7 ac 4b 00       	call   0x1411fe870
   140d43b79:	85 c0                	test   eax,eax
   140d43b7b:	0f 84 38 03 00 00    	je     0x140d43eb9
   140d43b81:	3d 40 01 00 80       	cmp    eax,0x80000140
   140d43b86:	0f 84 2d 03 00 00    	je     0x140d43eb9
   140d43b8c:	48 8d 0d d5 9c f3 00 	lea    rcx,[rip+0xf39cd5]        # 0x141c7d868
   140d43b93:	45 33 c0             	xor    r8d,r8d
   140d43b96:	33 d2                	xor    edx,edx
   140d43b98:	e8 53 59 02 00       	call   0x140d694f0
   140d43b9d:	84 c0                	test   al,al
   140d43b9f:	0f 84 14 03 00 00    	je     0x140d43eb9
   140d43ba5:	48 8d 05 a4 08 65 00 	lea    rax,[rip+0x6508a4]        # 0x141394450
   140d43bac:	48                   	rex.W
   140d43bad:	8d                   	.byte 0x8d
   140d43bae:	15                   	.byte 0x15
   140d43baf:	b5                   	.byte 0xb5
